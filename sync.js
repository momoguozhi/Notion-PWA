import { APP_SCHEMA, DATA_SOURCE_KEYS, ENTITY, createLocalRecord } from "./schema.js";
import { localDb } from "./storage.js";
import { notionApi, NotionApiError } from "./notion-api.js";

function property(page, id) {
  return Object.values(page.properties || {}).find(value => value.id === id) || null;
}

const readers = {
  title: value => value?.title?.map(part => part.plain_text || part.text?.content || "").join("") || "",
  number: value => value?.number ?? null,
  date: value => value?.date?.start || "",
  rich_text: value => value?.rich_text?.map(part => part.plain_text || part.text?.content || "").join("") || "",
  select: value => value?.select?.name || "",
  relation: value => value?.relation?.map(item => item.id) || [],
  files: value => value?.files || [],
  unique_id: value => value?.unique_id ? `${value.unique_id.prefix ? `${value.unique_id.prefix}-` : ""}${value.unique_id.number}` : null
};

function read(page, id, type) { return readers[type](property(page, id)); }
function titleValue(value) { return { title: value ? [{ type: "text", text: { content: value } }] : [] }; }
function textValue(value) { return { rich_text: value ? [{ type: "text", text: { content: value } }] : [] }; }
function dateValue(value) { return { date: value ? { start: value } : null }; }
function selectValue(value) { return { select: value ? { name: value } : null }; }
function relationValue(pageIds) { return { relation: pageIds.filter(Boolean).map(id => ({ id })) }; }

function remoteIdentity(page, entity, existing) {
  return {
    localId: existing?.localId || crypto.randomUUID(),
    entity,
    notionPageId: page.id,
    notionUniqueId: existing?.notionUniqueId || null,
    dirty: false,
    pending: false,
    lastRemoteEdit: page.last_edited_time,
    syncBase: page.last_edited_time,
    uploadError: null,
    createdAt: existing?.createdAt || page.created_time,
    updatedAt: page.last_edited_time
  };
}

function dataSourceMap(connection, entity) {
  return { dataSourceId: connection.dataSourceIds[entity], ids: connection.propertyIds[entity] };
}

function mapRemotePage(entity, page, connection, existing) {
  const { ids } = dataSourceMap(connection, entity);
  const base = remoteIdentity(page, entity, existing);
  if (entity === ENTITY.MAJOR) return { ...base, name: read(page, ids.name, "title"), sort: read(page, ids.sort, "number") ?? 0 };
  if (entity === ENTITY.SUB) return { ...base, name: read(page, ids.name, "title"), majorPageId: read(page, ids.major, "relation")[0] || null, majorLocalId: null, sort: read(page, ids.sort, "number") ?? 0 };
  if (entity === ENTITY.ITEM) return {
    ...base,
    name: read(page, ids.name, "title"),
    notionUniqueId: read(page, ids.uniqueId, "unique_id"),
    acquisitionDate: read(page, ids.acquisitionDate, "date"),
    source: read(page, ids.source, "rich_text"),
    subPageId: read(page, ids.sub, "relation")[0] || null,
    subLocalId: null,
    price: read(page, ids.price, "number"),
    currency: read(page, ids.currency, "select") || "JPY",
    quantity: read(page, ids.quantity, "number") ?? 1,
    status: read(page, ids.status, "select") || "在库",
    entryType: read(page, ids.entryType, "select") || "成品",
    remoteFiles: read(page, ids.photos, "files"),
    photoIds: [],
    directSourcePageId: read(page, ids.directSource, "relation")[0] || null,
    directSourceLocalId: null,
    cuttingDate: read(page, ids.cuttingDate, "date")
  };
  return {
    ...base,
    name: read(page, ids.name, "title"),
    motherPageId: read(page, ids.mother, "relation")[0] || null,
    fatherPageId: read(page, ids.father, "relation")[0] || null,
    motherLocalId: null, fatherLocalId: null,
    pollinationDate: read(page, ids.pollinationDate, "date"),
    harvestDate: read(page, ids.harvestDate, "date"),
    childPageIds: read(page, ids.children, "relation"),
    childLocalIds: []
  };
}

function fileUrl(file) { return file.file?.url || file.external?.url || ""; }

function resolveRelations(staging) {
  const all = [...staging.majorCategories, ...staging.subCategories, ...staging.items, ...staging.pairings];
  const byPage = new Map(all.filter(record => record.notionPageId).map(record => [record.notionPageId, record.localId]));
  staging.subCategories.forEach(record => { record.majorLocalId = byPage.get(record.majorPageId) || null; });
  staging.items.forEach(record => {
    record.subLocalId = byPage.get(record.subPageId) || null;
    record.directSourceLocalId = byPage.get(record.directSourcePageId) || null;
    record.photoIds = [];
    (record.remoteFiles || []).slice(0, 5).forEach((file, order) => {
      const photo = {
        localId: crypto.randomUUID(), itemLocalId: record.localId, order,
        name: file.name || `照片 ${order + 1}`, blob: null,
        remoteUrl: fileUrl(file), externalUrl: fileUrl(file), remoteExpiry: file.file?.expiry_time || null,
        notionFile: file, dirty: false, pending: false
      };
      staging.photos.push(photo); record.photoIds.push(photo.localId);
    });
    delete record.remoteFiles;
  });
  staging.pairings.forEach(record => {
    record.motherLocalId = byPage.get(record.motherPageId) || null;
    record.fatherLocalId = byPage.get(record.fatherPageId) || null;
    record.childLocalIds = record.childPageIds.map(id => byPage.get(id)).filter(Boolean);
  });
}

function recordChanged(local, remote) {
  return !local || local.lastRemoteEdit !== remote.lastRemoteEdit;
}

export function wouldCreateSourceCycle(itemId, sourceId, items) {
  if (!sourceId) return false;
  const byId = new Map(items.map(item => [item.localId, item]));
  let cursor = sourceId;
  const visited = new Set();
  while (cursor) {
    if (cursor === itemId || visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = byId.get(cursor)?.directSourceLocalId || null;
  }
  return false;
}

class SyncCoordinator {
  async fetchRemoteWorkspace(connection) {
    const local = await localDb.loadWorkspace();
    const staging = { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
    for (const entity of DATA_SOURCE_KEYS) {
      const pages = await notionApi.queryAll(connection.dataSourceIds[entity]);
      const existingByPage = new Map(local[entity].filter(record => record.notionPageId).map(record => [record.notionPageId, record]));
      staging[entity] = pages.map(page => mapRemotePage(entity, page, connection, existingByPage.get(page.id)));
    }
    resolveRelations(staging);
    const summary = { additions: 0, remoteChanges: 0, conflicts: [], remoteDeletes: [] };
    for (const entity of DATA_SOURCE_KEYS) {
      const remoteByPage = new Map(staging[entity].map(record => [record.notionPageId, record]));
      local[entity].forEach(record => {
        if (!record.notionPageId) return;
        const remote = remoteByPage.get(record.notionPageId);
        if (!remote && record.dirty) summary.conflicts.push({ entity, localId: record.localId, name: record.name || record.localId, local: record, remote: null });
        else if (!remote) summary.remoteDeletes.push({ entity, localId: record.localId, name: record.name || record.localId });
        else if (record.dirty && recordChanged(record, remote)) summary.conflicts.push({ entity, localId: record.localId, name: record.name || record.localId, local: record, remote });
        else if (recordChanged(record, remote)) summary.remoteChanges += 1;
      });
      staging[entity].forEach(record => {
        if (!local[entity].some(item => item.notionPageId === record.notionPageId)) summary.additions += 1;
      });
    }
    await localDb.put("staging", { localId: "remote-refresh", staging, summary, fetchedAt: new Date().toISOString() });
    return { staging, summary };
  }

  async applyRemote(staging, conflictChoices = {}) {
    const local = await localDb.loadWorkspace();
    for (const entity of DATA_SOURCE_KEYS) {
      const localByPage = new Map(local[entity].filter(record => record.notionPageId).map(record => [record.notionPageId, record]));
      const merged = [];
      staging[entity].forEach(remote => {
        const current = localByPage.get(remote.notionPageId);
        if (current?.dirty && current.lastRemoteEdit !== remote.lastRemoteEdit && conflictChoices[current.localId] !== "remote") merged.push(current);
        else merged.push(remote);
      });
      local[entity].filter(record => !record.notionPageId).forEach(record => merged.push(record));
      const remotePageIds = new Set(staging[entity].map(record => record.notionPageId));
      local[entity]
        .filter(record => record.notionPageId && !remotePageIds.has(record.notionPageId) && record.dirty && conflictChoices[record.localId] !== "remote")
        .forEach(record => merged.push(record));
      await localDb.replaceAll(entity, merged);
    }
    const finalItems = await localDb.getAll(ENTITY.ITEM);
    const requiredPhotoIds = new Set(finalItems.flatMap(item => item.photoIds || []));
    const availablePhotos = new Map([...local.photos, ...staging.photos].map(photo => [photo.localId, photo]));
    await localDb.replaceAll("photos", [...requiredPhotoIds].map(id => availablePhotos.get(id)).filter(Boolean));
    await localDb.setSyncMeta("last-refresh", { completedAt: new Date().toISOString() });
    await localDb.remove("staging", "remote-refresh");
  }

  async buildProperties(entity, record, connection, workspace, includePhotos = false) {
    const ids = connection.propertyIds[entity];
    const pageId = localId => {
      const target = [...workspace.majorCategories, ...workspace.subCategories, ...workspace.items].find(item => item.localId === localId);
      return target?.notionPageId || null;
    };
    if (entity === ENTITY.MAJOR) return { [ids.name]: titleValue(record.name), [ids.sort]: { number: record.sort ?? 0 } };
    if (entity === ENTITY.SUB) return {
      [ids.name]: titleValue(record.name), [ids.major]: relationValue([pageId(record.majorLocalId)]), [ids.sort]: { number: record.sort ?? 0 }
    };
    if (entity === ENTITY.ITEM) {
      const properties = {
        [ids.name]: titleValue(record.name), [ids.acquisitionDate]: dateValue(record.acquisitionDate),
        [ids.source]: textValue(record.source), [ids.sub]: relationValue([pageId(record.subLocalId)]),
        [ids.price]: { number: record.price === "" || record.price == null ? null : Number(record.price) },
        [ids.currency]: selectValue(record.currency), [ids.quantity]: { number: Number(record.quantity ?? 1) },
        [ids.status]: selectValue(record.status), [ids.entryType]: selectValue(record.entryType),
        [ids.directSource]: relationValue([pageId(record.directSourceLocalId)]), [ids.cuttingDate]: dateValue(record.cuttingDate)
      };
      if (includePhotos) {
        const photos = workspace.photos.filter(photo => record.photoIds?.includes(photo.localId)).sort((a,b) => a.order-b.order).slice(0,5);
        properties[ids.photos] = { files: photos.map(photo => photo.fileUploadId ? { type: "file_upload", file_upload: { id: photo.fileUploadId } } : photo.externalUrl ? { type: "external", name: photo.name, external: { url: photo.externalUrl } } : null).filter(Boolean) };
      }
      return properties;
    }
    return {
      [ids.name]: titleValue(record.name), [ids.mother]: relationValue([pageId(record.motherLocalId)]),
      [ids.father]: relationValue([pageId(record.fatherLocalId)]), [ids.pollinationDate]: dateValue(record.pollinationDate),
      [ids.harvestDate]: dateValue(record.harvestDate), [ids.children]: relationValue((record.childLocalIds || []).map(pageId))
    };
  }

  dependencies(entity, record) {
    if (entity === ENTITY.SUB) return [{ entity: ENTITY.MAJOR, localId: record.majorLocalId }];
    if (entity === ENTITY.ITEM) return [{ entity: ENTITY.SUB, localId: record.subLocalId }, { entity: ENTITY.ITEM, localId: record.directSourceLocalId }].filter(item => item.localId);
    if (entity === ENTITY.PAIRING) return [
      { entity: ENTITY.ITEM, localId: record.motherLocalId }, { entity: ENTITY.ITEM, localId: record.fatherLocalId },
      ...(record.childLocalIds || []).map(localId => ({ entity: ENTITY.ITEM, localId }))
    ].filter(item => item.localId);
    return [];
  }

  async uploadRecord(entity, localId, connection, { force = false, visiting = new Set() } = {}) {
    const visitKey = `${entity}:${localId}`;
    if (visiting.has(visitKey)) throw new Error("检测到 Relation 循环，已停止上传。");
    visiting.add(visitKey);
    let workspace = await localDb.loadWorkspace();
    let record = workspace[entity].find(item => item.localId === localId);
    if (!record) throw new Error("找不到待上传的本地记录。");
    for (const dependency of this.dependencies(entity, record)) {
      const target = workspace[dependency.entity].find(item => item.localId === dependency.localId);
      if (target && !target.notionPageId) await this.uploadRecord(dependency.entity, dependency.localId, connection, { force, visiting });
    }
    workspace = await localDb.loadWorkspace();
    record = workspace[entity].find(item => item.localId === localId);
    if (record.notionPageId && !force) {
      const remote = await notionApi.retrievePage(record.notionPageId);
      if (record.syncBase && remote.last_edited_time !== record.syncBase) {
        throw new NotionApiError(`“${record.name || "未命名记录"}”在 Notion 和本地都已变化，需要用户决定是否覆盖。`, { code: "local_remote_conflict", details: { remote, record } });
      }
    }
    let includePhotos = false;
    if (entity === ENTITY.ITEM) {
      const photos = workspace.photos.filter(photo => record.photoIds?.includes(photo.localId)).sort((a,b) => a.order-b.order).slice(0,5);
      for (const photo of photos) {
        if (photo.blob && !photo.fileUploadId) {
          photo.fileUploadId = await notionApi.uploadFile(photo.blob);
          photo.pending = true;
          await localDb.put("photos", photo);
          includePhotos = true;
        }
      }
      includePhotos = includePhotos || !record.notionPageId || Boolean(record.photosChanged);
      workspace = await localDb.loadWorkspace();
    }
    const properties = await this.buildProperties(entity, record, connection, workspace, includePhotos);
    const page = record.notionPageId
      ? await notionApi.updatePage(record.notionPageId, properties)
      : await notionApi.createPage(connection.dataSourceIds[entity], properties);
    const ids = connection.propertyIds[entity];
    record.notionPageId = page.id;
    if (entity === ENTITY.ITEM) record.notionUniqueId = read(page, ids.uniqueId, "unique_id");
    record.dirty = false; record.pending = false; record.uploadError = null;
    record.lastRemoteEdit = page.last_edited_time; record.syncBase = page.last_edited_time;
    record.updatedAt = new Date().toISOString(); record.photosChanged = false;
    await localDb.put(entity, record);
    visiting.delete(visitKey);
    return record;
  }

  async uploadPending(connection, onProgress = () => {}) {
    const results = { uploaded: 0, failed: [] };
    for (const entity of DATA_SOURCE_KEYS) {
      const records = (await localDb.getAll(entity)).filter(record => record.pending);
      for (const record of records) {
        onProgress(`正在上传 ${APP_SCHEMA[entity].title}：${record.name || "未命名"}`);
        try { await this.uploadRecord(entity, record.localId, connection); results.uploaded += 1; }
        catch (error) {
          record.uploadError = error.message; await localDb.put(entity, record);
          results.failed.push({ entity, localId: record.localId, name: record.name, error });
          if (error.code === "local_remote_conflict") return results;
        }
      }
    }
    return results;
  }
}

export const syncCoordinator = new SyncCoordinator();

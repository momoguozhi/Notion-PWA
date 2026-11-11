import { APP_SCHEMA, DATA_SOURCE_KEYS, ENTITY } from "./schema.js";
import { localDb } from "./storage.js";
import { notionApi, NotionApiError } from "./notion-api.js";

function property(page, id) { return Object.values(page.properties || {}).find(value => value.id === id) || null; }
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
function relationValue(pageIds) { return { relation: pageIds.map(id => ({ id })) }; }
function fileUrl(file) { return file.file?.url || file.external?.url || ""; }

function remoteIdentity(page, entity, existing, workspaceId) {
  return {
    localId: existing?.localId || crypto.randomUUID(), entity, workspaceId,
    notionPageId: page.id, notionPageUrl: page.url || existing?.notionPageUrl || null,
    notionUniqueId: existing?.notionUniqueId || null, dirty: false, pending: false,
    lastRemoteEdit: page.last_edited_time, syncBase: page.last_edited_time, uploadError: null,
    createdAt: existing?.createdAt || page.created_time, updatedAt: page.last_edited_time
  };
}

function dataSourceMap(connection, entity) {
  return { dataSourceId: connection.dataSourceIds[entity], ids: connection.propertyIds[entity] };
}

function mapRemotePage(entity, page, connection, existing, workspaceId) {
  const { ids } = dataSourceMap(connection, entity);
  const base = remoteIdentity(page, entity, existing, workspaceId);
  if (entity === ENTITY.MAJOR) return { ...base, name: read(page, ids.name, "title"), sort: read(page, ids.sort, "number") ?? 0 };
  if (entity === ENTITY.SUB) return { ...base, name: read(page, ids.name, "title"), majorPageId: read(page, ids.major, "relation")[0] || null, majorLocalId: null, sort: read(page, ids.sort, "number") ?? 0 };
  if (entity === ENTITY.ITEM) return {
    ...base, name: read(page, ids.name, "title"), notionUniqueId: read(page, ids.uniqueId, "unique_id"),
    acquisitionDate: read(page, ids.acquisitionDate, "date"), source: read(page, ids.source, "rich_text"),
    subPageId: read(page, ids.sub, "relation")[0] || null, subLocalId: null,
    price: read(page, ids.price, "number"), currency: read(page, ids.currency, "select") || "JPY",
    quantity: read(page, ids.quantity, "number") ?? 1,
    remoteFiles: read(page, ids.photos, "files"), photoIds: [],
    cuttingDate: read(page, ids.cuttingDate, "date")
  };
  return {
    ...base, name: read(page, ids.name, "title"), motherPageId: read(page, ids.mother, "relation")[0] || null,
    fatherPageId: read(page, ids.father, "relation")[0] || null, motherLocalId: null, fatherLocalId: null,
    pollinationDate: read(page, ids.pollinationDate, "date"), harvestDate: read(page, ids.harvestDate, "date"),
    childPageIds: read(page, ids.children, "relation"), childLocalIds: []
  };
}

function addRemotePhotos(staging, workspaceId) {
  staging.items.forEach(record => {
    record.photoIds = [];
    (record.remoteFiles || []).slice(0, 5).forEach((file, order) => {
      const photo = {
        localId: crypto.randomUUID(), workspaceId, itemLocalId: record.localId, order,
        name: file.name || `照片 ${order + 1}`, blob: null, remoteUrl: fileUrl(file),
        externalUrl: fileUrl(file), remoteExpiry: file.file?.expiry_time || null,
        notionFile: file, dirty: false, pending: false
      };
      staging.photos.push(photo); record.photoIds.push(photo.localId);
    });
    delete record.remoteFiles;
  });
}

export function resolveFinalRelations(workspace, remoteSelections) {
  const maps = Object.fromEntries(DATA_SOURCE_KEYS.map(entity => [entity, new Map(workspace[entity].filter(record => record.notionPageId).map(record => [record.notionPageId, record.localId]))]));
  const localIds = Object.fromEntries(DATA_SOURCE_KEYS.map(entity => [entity, new Set(workspace[entity].map(record => record.localId))]));
  const resolveOne = (pageId, entity, label, required = true) => {
    if (!pageId) {
      if (required) throw new Error(`Refresh 返回的${label} Relation 为空，已停止应用。`);
      return null;
    }
    const resolved = maps[entity].get(pageId);
    if (resolved) return resolved;
    throw new Error(`Refresh 无法在当前 Workspace 解析${label} Relation，已停止应用。`);
  };
  const validateLocal = (localId, entity, label, required = true) => {
    if (!localId) {
      if (required) throw new Error(`本地${label} Relation 为空，已停止应用。`);
      return;
    }
    if (!localIds[entity].has(localId)) throw new Error(`本地${label} Relation 不属于当前最终 Workspace，已停止应用。`);
  };
  workspace.subCategories.forEach(record => {
    if (remoteSelections[ENTITY.SUB].has(record.localId)) record.majorLocalId = resolveOne(record.majorPageId, ENTITY.MAJOR, "大分类");
    else validateLocal(record.majorLocalId, ENTITY.MAJOR, "大分类");
  });
  workspace.items.forEach(record => {
    if (remoteSelections[ENTITY.ITEM].has(record.localId)) record.subLocalId = resolveOne(record.subPageId, ENTITY.SUB, "小分类");
    else validateLocal(record.subLocalId, ENTITY.SUB, "小分类");
  });
  workspace.pairings.forEach(record => {
    if (remoteSelections[ENTITY.PAIRING].has(record.localId)) {
      record.motherLocalId = resolveOne(record.motherPageId, ENTITY.ITEM, "母本");
      record.fatherLocalId = resolveOne(record.fatherPageId, ENTITY.ITEM, "父本");
      record.childLocalIds = (record.childPageIds || []).map(pageId => resolveOne(pageId, ENTITY.ITEM, "子代"));
    } else {
      validateLocal(record.motherLocalId, ENTITY.ITEM, "母本");
      validateLocal(record.fatherLocalId, ENTITY.ITEM, "父本");
      (record.childLocalIds || []).forEach(localId => validateLocal(localId, ENTITY.ITEM, "子代"));
    }
  });
}

export function mergeEntityRecords(localRecords, remoteRecords, conflictChoices = {}) {
  const localByPage = new Map(localRecords.filter(record => record.notionPageId).map(record => [record.notionPageId, record]));
  const seen = new Set();
  const records = [];
  const remoteSelectedIds = new Set();
  remoteRecords.forEach(remote => {
    const current = localByPage.get(remote.notionPageId);
    seen.add(remote.notionPageId);
    if (current && (current.dirty || current.pending) && conflictChoices[current.localId] !== "remote") records.push(current);
    else { records.push(remote); remoteSelectedIds.add(remote.localId); }
  });
  localRecords.filter(record => !record.notionPageId || !seen.has(record.notionPageId)).forEach(record => records.push(record));
  return { records, remoteSelectedIds };
}

function recordChanged(local, remote) { return !local || local.lastRemoteEdit !== remote.lastRemoteEdit; }
function guardContext(connection, context) {
  if (!context?.workspaceId || context.workspaceId !== connection.databaseId) throw new Error("同步操作缺少有效 Workspace 会话。");
  context.assertCurrent();
}

class SyncCoordinator {
  async fetchRemoteWorkspace(connection, context) {
    guardContext(connection, context);
    const workspaceId = context.workspaceId;
    const local = await localDb.loadWorkspace(workspaceId);
    const staging = { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
    for (const entity of DATA_SOURCE_KEYS) {
      const pages = await notionApi.queryAll(connection.dataSourceIds[entity]);
      guardContext(connection, context);
      const existingByPage = new Map(local[entity].filter(record => record.notionPageId).map(record => [record.notionPageId, record]));
      staging[entity] = pages.map(page => mapRemotePage(entity, page, connection, existingByPage.get(page.id), workspaceId));
    }
    addRemotePhotos(staging, workspaceId);
    const summary = { additions: 0, remoteChanges: 0, conflicts: [], remoteDeletes: [] };
    for (const entity of DATA_SOURCE_KEYS) {
      const remoteByPage = new Map(staging[entity].map(record => [record.notionPageId, record]));
      local[entity].forEach(record => {
        if (!record.notionPageId) return;
        const remote = remoteByPage.get(record.notionPageId);
        if (!remote) summary.remoteDeletes.push({ entity, localId: record.localId, name: record.name || record.localId });
        else if ((record.dirty || record.pending) && recordChanged(record, remote)) summary.conflicts.push({ entity, localId: record.localId, name: record.name || record.localId, local: record, remote });
        else if (!(record.dirty || record.pending) && recordChanged(record, remote)) summary.remoteChanges += 1;
      });
      staging[entity].forEach(record => {
        if (!local[entity].some(item => item.notionPageId === record.notionPageId)) summary.additions += 1;
      });
    }
    guardContext(connection, context);
    await localDb.putRemoteRefresh(staging, summary, workspaceId, context.sessionId);
    return { staging, summary, workspaceId, sessionId: context.sessionId };
  }

  async applyRemote(connection, draft, conflictChoices = {}, context) {
    guardContext(connection, context);
    if (draft.workspaceId !== context.workspaceId || draft.sessionId !== context.sessionId) throw new Error("该 Refresh 预览属于已失效的连接会话。");
    const staging = draft.staging;
    const local = await localDb.loadWorkspace(context.workspaceId);
    const final = { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
    const remoteSelections = Object.fromEntries(DATA_SOURCE_KEYS.map(entity => [entity, new Set()]));
    for (const entity of DATA_SOURCE_KEYS) {
      const merged = mergeEntityRecords(local[entity], staging[entity], conflictChoices);
      final[entity] = merged.records;
      remoteSelections[entity] = merged.remoteSelectedIds;
    }
    resolveFinalRelations(final, remoteSelections);
    const requiredPhotoIds = new Set(final.items.flatMap(item => item.photoIds || []));
    const availablePhotos = new Map([...local.photos, ...staging.photos].map(photo => [photo.localId, photo]));
    final.photos = [...requiredPhotoIds].map(id => availablePhotos.get(id)).filter(Boolean);
    guardContext(connection, context);
    await localDb.applyRefreshWorkspace(final, context.workspaceId, context.sessionId);
  }

  relationPageId(workspace, entity, localId, label, workspaceId) {
    if (!localId) return null;
    const target = workspace[entity].find(item => item.localId === localId && item.workspaceId === workspaceId);
    if (!target) throw new Error(`${label} Relation 在当前 Workspace 中无效，已停止上传。`);
    if (!target.notionPageId) throw new Error(`${label} Relation 目标尚未取得 Notion Page ID，已停止上传。`);
    return target.notionPageId;
  }

  async buildProperties(entity, record, connection, workspace, includePhotos = false) {
    if (record.workspaceId !== connection.databaseId) throw new Error("Relation 来源记录不属于当前 Workspace，已停止上传。");
    const ids = connection.propertyIds[entity];
    const pageId = (targetEntity, localId, label) => this.relationPageId(workspace, targetEntity, localId, label, connection.databaseId);
    if (entity === ENTITY.MAJOR) return { [ids.name]: titleValue(record.name), [ids.sort]: { number: record.sort ?? 0 } };
    if (entity === ENTITY.SUB) return { [ids.name]: titleValue(record.name), [ids.major]: relationValue(record.majorLocalId ? [pageId(ENTITY.MAJOR, record.majorLocalId, "大分类")] : []), [ids.sort]: { number: record.sort ?? 0 } };
    if (entity === ENTITY.ITEM) {
      const properties = {
        [ids.name]: titleValue(record.name), [ids.acquisitionDate]: dateValue(record.acquisitionDate), [ids.source]: textValue(record.source),
        [ids.sub]: relationValue(record.subLocalId ? [pageId(ENTITY.SUB, record.subLocalId, "小分类")] : []),
        [ids.price]: { number: record.price === "" || record.price == null ? null : Number(record.price) },
        [ids.currency]: selectValue(record.currency), [ids.quantity]: { number: Number(record.quantity ?? 1) },
        [ids.cuttingDate]: dateValue(record.cuttingDate)
      };
      if (includePhotos) {
        const photos = workspace.photos.filter(photo => photo.workspaceId === connection.databaseId && record.photoIds?.includes(photo.localId)).sort((a,b) => a.order-b.order).slice(0,5);
        properties[ids.photos] = { files: photos.map(photo => photo.fileUploadId ? { type: "file_upload", file_upload: { id: photo.fileUploadId } } : photo.externalUrl ? { type: "external", name: photo.name, external: { url: photo.externalUrl } } : null).filter(Boolean) };
      }
      return properties;
    }
    return {
      [ids.name]: titleValue(record.name),
      [ids.mother]: relationValue(record.motherLocalId ? [pageId(ENTITY.ITEM, record.motherLocalId, "母本")] : []),
      [ids.father]: relationValue(record.fatherLocalId ? [pageId(ENTITY.ITEM, record.fatherLocalId, "父本")] : []),
      [ids.pollinationDate]: dateValue(record.pollinationDate), [ids.harvestDate]: dateValue(record.harvestDate),
      [ids.children]: relationValue((record.childLocalIds || []).map(id => pageId(ENTITY.ITEM, id, "子代")))
    };
  }

  dependencies(entity, record) {
    if (entity === ENTITY.SUB) return record.majorLocalId ? [{ entity: ENTITY.MAJOR, localId: record.majorLocalId }] : [];
    if (entity === ENTITY.ITEM) return record.subLocalId ? [{ entity: ENTITY.SUB, localId: record.subLocalId }] : [];
    if (entity === ENTITY.PAIRING) return [{ entity: ENTITY.ITEM, localId: record.motherLocalId }, { entity: ENTITY.ITEM, localId: record.fatherLocalId }, ...(record.childLocalIds || []).map(localId => ({ entity: ENTITY.ITEM, localId }))].filter(item => item.localId);
    return [];
  }

  async uploadRecord(entity, localId, connection, { force = false, visiting = new Set(), context } = {}) {
    guardContext(connection, context);
    const visitKey = `${entity}:${localId}`;
    if (visiting.has(visitKey)) throw new Error("检测到 Relation 循环，已停止上传。");
    visiting.add(visitKey);
    let workspace = await localDb.loadWorkspace(context.workspaceId);
    let record = workspace[entity].find(item => item.localId === localId && item.workspaceId === context.workspaceId);
    if (!record) throw new Error("找不到当前 Workspace 的待上传记录。");
    for (const dependency of this.dependencies(entity, record)) {
      const target = workspace[dependency.entity].find(item => item.localId === dependency.localId && item.workspaceId === context.workspaceId);
      if (!target) throw new Error("Relation 目标不属于当前 Workspace，已停止上传。");
      if (!target.notionPageId) await this.uploadRecord(dependency.entity, dependency.localId, connection, { force, visiting, context });
    }
    guardContext(connection, context);
    workspace = await localDb.loadWorkspace(context.workspaceId);
    record = workspace[entity].find(item => item.localId === localId);
    if (record.notionPageId && !force) {
      const remote = await notionApi.retrievePage(record.notionPageId); guardContext(connection, context);
      if (record.syncBase && remote.last_edited_time !== record.syncBase) throw new NotionApiError(`“${record.name || "未命名记录"}”在 Notion 和本地都已变化，需要用户决定是否覆盖。`, { code: "local_remote_conflict", details: { remote, record } });
    }
    let includePhotos = false;
    if (entity === ENTITY.ITEM) {
      const photos = workspace.photos.filter(photo => photo.workspaceId === context.workspaceId && record.photoIds?.includes(photo.localId)).sort((a,b) => a.order-b.order).slice(0,5);
      for (const photo of photos) {
        if (photo.blob && !photo.fileUploadId) {
          photo.fileUploadId = await notionApi.uploadFile(photo.blob); guardContext(connection, context);
          photo.pending = true; await localDb.put("photos", photo, context.workspaceId, context.sessionId); includePhotos = true;
        }
      }
      includePhotos = includePhotos || !record.notionPageId || Boolean(record.photosChanged);
      workspace = await localDb.loadWorkspace(context.workspaceId);
    }
    const properties = await this.buildProperties(entity, record, connection, workspace, includePhotos);
    const page = record.notionPageId ? await notionApi.updatePage(record.notionPageId, properties) : await notionApi.createPage(connection.dataSourceIds[entity], properties);
    guardContext(connection, context);
    const ids = connection.propertyIds[entity];
    record.notionPageId = page.id; record.notionPageUrl = page.url || record.notionPageUrl || null;
    if (entity === ENTITY.ITEM) record.notionUniqueId = read(page, ids.uniqueId, "unique_id");
    record.dirty = false; record.pending = false; record.uploadError = null;
    record.lastRemoteEdit = page.last_edited_time; record.syncBase = page.last_edited_time;
    record.updatedAt = new Date().toISOString(); record.photosChanged = false;
    await localDb.put(entity, record, context.workspaceId, context.sessionId); visiting.delete(visitKey); return record;
  }

  async uploadPending(connection, context, onProgress = () => {}) {
    guardContext(connection, context);
    const results = { uploaded: 0, failed: [] };
    for (const entity of DATA_SOURCE_KEYS) {
      const records = (await localDb.getAll(entity, context.workspaceId)).filter(record => record.pending);
      for (const record of records) {
        guardContext(connection, context); onProgress(`正在上传 ${APP_SCHEMA[entity].title}：${record.name || "未命名"}`);
        try { await this.uploadRecord(entity, record.localId, connection, { context }); results.uploaded += 1; }
        catch (error) {
          context.assertCurrent(); record.uploadError = error.message; await localDb.put(entity, record, context.workspaceId, context.sessionId);
          results.failed.push({ entity, localId: record.localId, name: record.name, error });
          if (error.code === "local_remote_conflict") return results;
        }
      }
    }
    return results;
  }
}

export const syncCoordinator = new SyncCoordinator();

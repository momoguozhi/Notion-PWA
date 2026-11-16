import { APP_SCHEMA, DATA_SOURCE_KEYS, ENTITY } from "./schema.js";
import { localDb } from "./storage.js";
import { notionApi, NotionApiError } from "./notion-api.js";
import { categoryIssue } from "./logic.js";

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
    remoteFiles: read(page, ids.photos, "files"), photoIds: []
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

export function resolveFinalRelations(workspace, remoteSelections, { validatePairings = true } = {}) {
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
  if (validatePairings) workspace.pairings.forEach(record => {
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

const MANAGED_MISSING = new Set([ENTITY.MAJOR, ENTITY.SUB, ENTITY.ITEM]);
const ENTITY_LABELS = { [ENTITY.MAJOR]: "大分类", [ENTITY.SUB]: "小分类", [ENTITY.ITEM]: "具体资料", [ENTITY.PAIRING]: "配对记录" };
const FIELD_LABELS = {
  name: "名称", sort: "排序", majorLocalId: "所属大分类", subLocalId: "小分类",
  acquisitionDate: "入手日期", source: "来源", price: "价格", currency: "币种", quantity: "数量",
  motherLocalId: "母本", fatherLocalId: "父本", pollinationDate: "授粉日期", harvestDate: "收获日期", childLocalIds: "子代"
};
const BUSINESS_FIELDS = {
  [ENTITY.MAJOR]: ["name", "sort"],
  [ENTITY.SUB]: ["name", "majorLocalId"],
  [ENTITY.ITEM]: ["name", "acquisitionDate", "source", "subLocalId", "price", "currency", "quantity"],
  [ENTITY.PAIRING]: ["name", "motherLocalId", "fatherLocalId", "pollinationDate", "harvestDate", "childLocalIds"]
};

function displayEmpty(value) { return value === "" || value == null ? "（空）" : String(value); }
function relationIdentity(record, field, entity, workspace, remote = false) {
  const relationEntity = field === "majorLocalId" ? ENTITY.MAJOR : field === "subLocalId" ? ENTITY.SUB : ENTITY.ITEM;
  if (field === "childLocalIds") {
    const ids = remote ? (record.childPageIds || []) : (record.childLocalIds || []);
    return ids.map(id => {
      const target = workspace[relationEntity].find(item => remote ? item.notionPageId === id : item.localId === id);
      return { identity: remote ? id : (target?.notionPageId || `local:${id}`), label: target?.name || "（无法识别）" };
    });
  }
  const pageField = field === "majorLocalId" ? "majorPageId" : field === "subLocalId" ? "subPageId" : field === "motherLocalId" ? "motherPageId" : "fatherPageId";
  const id = remote ? record[pageField] : record[field];
  const target = workspace[relationEntity].find(item => remote ? item.notionPageId === id : item.localId === id);
  return { identity: remote ? id : (target?.notionPageId || (id ? `local:${id}` : null)), label: target?.name || (id ? "（无法识别）" : "（空）") };
}

export function businessDiffs(entity, local, remote, workspace) {
  return BUSINESS_FIELDS[entity].flatMap(field => {
    const relation = field.endsWith("LocalId") || field === "childLocalIds";
    const left = relation ? relationIdentity(local, field, entity, workspace, false) : local[field];
    const right = relation ? relationIdentity(remote, field, entity, workspace, true) : remote[field];
    const leftIdentity = relation ? JSON.stringify(Array.isArray(left) ? left.map(item => item.identity) : left.identity) : JSON.stringify(left ?? null);
    const rightIdentity = relation ? JSON.stringify(Array.isArray(right) ? right.map(item => item.identity) : right.identity) : JSON.stringify(right ?? null);
    if (leftIdentity === rightIdentity) return [];
    return [{ field, label: FIELD_LABELS[field], local: relation ? (Array.isArray(left) ? left.map(item => item.label).join("、") || "（空）" : left.label) : displayEmpty(left), remote: relation ? (Array.isArray(right) ? right.map(item => item.label).join("、") || "（空）" : right.label) : displayEmpty(right) }];
  });
}

function remoteCategoryIssue(item, staging) {
  const sub = staging.subCategories.find(record => record.notionPageId === item.subPageId);
  if (!item.subPageId || !sub) return "远程小分类为空或不存在";
  const major = staging.majorCategories.find(record => record.notionPageId === sub.majorPageId);
  if (!sub.majorPageId || !major) return `小分类“${sub.name || "未命名"}”的所属大分类为空或不存在`;
  return null;
}

export function buildRefreshSummary(local, staging) {
  const summary = { additions: 0, additionRecords: [], remoteChanges: 0, remoteChangeRecords: [], conflicts: [], remoteDeletes: [], categoryIssues: [], anomalies: [] };
  const comparisonWorkspace = Object.fromEntries(DATA_SOURCE_KEYS.map(entity => [entity, [...local[entity], ...staging[entity]]]));
  for (const entity of DATA_SOURCE_KEYS) {
    const remoteByPage = new Map(staging[entity].map(record => [record.notionPageId, record]));
    const localByPage = new Map(local[entity].filter(record => record.notionPageId).map(record => [record.notionPageId, record]));
    local[entity].forEach(record => {
      if (!record.notionPageId) return;
      const remote = remoteByPage.get(record.notionPageId);
      if (!remote) summary.remoteDeletes.push({ entity, entityLabel: ENTITY_LABELS[entity], localId: record.localId, pageId: record.notionPageId, name: record.name || record.localId, managed: MANAGED_MISSING.has(entity), known: Boolean(record.remoteMissing) });
      else if ((record.dirty || record.pending) && recordChanged(record, remote)) summary.conflicts.push({ entity, entityLabel: ENTITY_LABELS[entity], localId: record.localId, name: record.name || record.localId, local: record, remote, diffs: businessDiffs(entity, record, remote, comparisonWorkspace) });
      else if (!(record.dirty || record.pending) && recordChanged(record, remote)) {
        summary.remoteChanges += 1;
        summary.remoteChangeRecords.push({ entity, entityLabel: ENTITY_LABELS[entity], localId: record.localId, name: record.name || record.localId, diffs: businessDiffs(entity, record, remote, comparisonWorkspace) });
      }
    });
    staging[entity].forEach(record => {
      if (!localByPage.has(record.notionPageId)) {
        summary.additions += 1;
        summary.additionRecords.push({ entity, entityLabel: ENTITY_LABELS[entity], localId: record.localId, name: record.name || record.localId });
      }
    });
  }
  staging.items.forEach(record => {
    const reason = remoteCategoryIssue(record, staging);
    if (reason) summary.categoryIssues.push({ entity: ENTITY.ITEM, localId: record.localId, pageId: record.notionPageId, name: record.name || record.localId, reason, existing: local.items.some(item => item.notionPageId === record.notionPageId) });
  });
  staging.subCategories.forEach(record => {
    if (!record.majorPageId || !staging.majorCategories.some(major => major.notionPageId === record.majorPageId)) summary.anomalies.push({ entity: ENTITY.SUB, localId: record.localId, name: record.name || record.localId, reason: "所属大分类为空或不存在；本次不应用该远程记录" });
  });
  staging.pairings.forEach(record => {
    const itemIds = new Set(staging.items.map(item => item.notionPageId));
    if (!record.motherPageId || !record.fatherPageId || !itemIds.has(record.motherPageId) || !itemIds.has(record.fatherPageId) || (record.childPageIds || []).some(id => !itemIds.has(id))) {
      summary.anomalies.push({ entity: ENTITY.PAIRING, localId: record.localId, name: record.name || record.localId, reason: "配对 Relation 缺失或无法解析；本次保留既有本地记录，不阻断具体资料" });
    }
  });
  return summary;
}

export function validateRefreshChoices(summary, choices = {}) {
  const missing = summary.remoteDeletes.filter(item => item.managed && !item.known && !["delete", "defer"].includes(choices.missing?.[item.localId]));
  if (missing.length) throw new NotionApiError(`还有 ${missing.length} 条缺失记录未选择处理方式`, { code: "missing_choices_required", details: missing.map(item => item.localId) });
  const categories = summary.categoryIssues.filter(item => !["skip", "remap"].includes(choices.categories?.[item.localId]?.action));
  if (categories.length) throw new NotionApiError(`还有 ${categories.length} 条分类异常记录未选择处理方式`, { code: "category_choices_required", details: categories.map(item => item.localId) });
}

export function missingDeleteBlock(entry, local, choices = {}) {
  if (entry.entity === ENTITY.MAJOR) {
    const records = local.subCategories.filter(record => record.majorLocalId === entry.localId && choices.missing?.[record.localId] !== "delete");
    return records.length ? { blocked: true, reason: `仍包含 ${records.length} 个小分类`, records } : { blocked: false, records: [] };
  }
  if (entry.entity === ENTITY.SUB) {
    const records = local.items.filter(record => {
      if (record.subLocalId !== entry.localId || choices.missing?.[record.localId] === "delete") return false;
      const remap = choices.categories?.[record.localId];
      return !(remap?.action === "remap" && remap.subLocalId !== entry.localId);
    });
    return records.length ? { blocked: true, reason: `仍被 ${records.length} 条具体资料使用`, records } : { blocked: false, records: [] };
  }
  return { blocked: false, records: [] };
}
function guardContext(connection, context) {
  if (!context?.workspaceId || context.workspaceId !== connection.databaseId) throw new Error("同步操作缺少有效 Workspace 会话。");
  context.assertCurrent();
}

class SyncCoordinator {
  constructor() {
    this.uploadBatches = new Map();
    this.recordUploads = new Map();
  }

  async runUploadBatch(connection, context, operation) {
    guardContext(connection, context);
    const key = context.workspaceId;
    if (this.uploadBatches.has(key)) throw new NotionApiError("当前 Workspace 已有 Upload 正在进行，请等待完成后重试。", { code: "upload_in_progress" });
    const marker = {};
    this.uploadBatches.set(key, marker);
    try { return await operation(); }
    finally { if (this.uploadBatches.get(key) === marker) this.uploadBatches.delete(key); }
  }

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
    const summary = buildRefreshSummary(local, staging);
    guardContext(connection, context);
    await localDb.putRemoteRefresh(staging, summary, workspaceId, context.sessionId);
    return { staging, summary, workspaceId, sessionId: context.sessionId };
  }

  async applyRemote(connection, draft, choices = {}, context) {
    guardContext(connection, context);
    if (draft.workspaceId !== context.workspaceId || draft.sessionId !== context.sessionId) throw new Error("该 Refresh 预览属于已失效的连接会话。");
    const staging = structuredClone(draft.staging);
    const local = await localDb.loadWorkspace(context.workspaceId);
    validateRefreshChoices(draft.summary, choices);
    const final = { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
    const remoteSelections = Object.fromEntries(DATA_SOURCE_KEYS.map(entity => [entity, new Set()]));
    const conflictChoices = choices.conflicts || choices;
    for (const entity of DATA_SOURCE_KEYS) {
      const merged = mergeEntityRecords(local[entity], staging[entity], conflictChoices);
      final[entity] = merged.records;
      remoteSelections[entity] = merged.remoteSelectedIds;
    }
    for (const anomaly of draft.summary.anomalies || []) {
      const current = local[anomaly.entity].find(record => record.notionPageId === staging[anomaly.entity].find(item => item.localId === anomaly.localId)?.notionPageId);
      final[anomaly.entity] = final[anomaly.entity].filter(record => record.localId !== anomaly.localId);
      remoteSelections[anomaly.entity].delete(anomaly.localId);
      if (current) final[anomaly.entity].push(current);
    }
    for (const issue of draft.summary.categoryIssues || []) {
      const choice = choices.categories[issue.localId];
      const remote = final.items.find(record => record.localId === issue.localId);
      const current = local.items.find(record => record.notionPageId === issue.pageId);
      if (choice.action === "skip") {
        final.items = final.items.filter(record => record.localId !== issue.localId);
        remoteSelections[ENTITY.ITEM].delete(issue.localId);
        if (current) final.items.push(current);
        continue;
      }
      const sub = final.subCategories.find(record => record.localId === choice.subLocalId && !record.remoteMissing);
      const major = final.majorCategories.find(record => record.localId === choice.majorLocalId && !record.remoteMissing);
      const resolvedMajorId = sub?.majorLocalId || final.majorCategories.find(record => record.notionPageId === sub?.majorPageId)?.localId;
      if (!remote || !sub || !major || resolvedMajorId !== major.localId) throw new NotionApiError(`“${issue.name}”选择的分类已失效，请重新选择。`, { code: "category_remap_invalid" });
      remote.subLocalId = sub.localId;
      remote.dirty = true;
      remote.pending = true;
      remote.updatedAt = new Date().toISOString();
      remoteSelections[ENTITY.ITEM].delete(issue.localId);
    }
    resolveFinalRelations(final, remoteSelections, { validatePairings: false });
    const itemByPage = new Map(final.items.filter(record => record.notionPageId).map(record => [record.notionPageId, record.localId]));
    final.pairings = final.pairings.flatMap(record => {
      if (!remoteSelections[ENTITY.PAIRING].has(record.localId)) return [record];
      const mother = itemByPage.get(record.motherPageId), father = itemByPage.get(record.fatherPageId);
      const children = (record.childPageIds || []).map(id => itemByPage.get(id));
      if (mother && father && children.every(Boolean)) return [{ ...record, motherLocalId: mother, fatherLocalId: father, childLocalIds: children }];
      const current = local.pairings.find(item => item.notionPageId === record.notionPageId);
      return current ? [current] : [];
    });
    const deletions = draft.summary.remoteDeletes.filter(entry => entry.managed && choices.missing?.[entry.localId] === "delete");
    for (const entry of draft.summary.remoteDeletes.filter(item => item.managed)) {
      const record = final[entry.entity].find(item => item.localId === entry.localId);
      if (!record) continue;
      const action = entry.known ? "defer" : choices.missing?.[entry.localId];
      if (action === "defer") record.remoteMissing = { pageId: entry.pageId, detectedAt: record.remoteMissing?.detectedAt || new Date().toISOString() };
    }
    for (const entry of deletions) {
      const blocked = entry.entity === ENTITY.MAJOR
        ? final.subCategories.filter(record => record.majorLocalId === entry.localId && !deletions.some(item => item.entity === ENTITY.SUB && item.localId === record.localId))
        : entry.entity === ENTITY.SUB
          ? final.items.filter(record => record.subLocalId === entry.localId && !deletions.some(item => item.entity === ENTITY.ITEM && item.localId === record.localId))
          : [];
      if (blocked.length) throw new NotionApiError(`无法删除“${entry.name}”：仍关联 ${blocked.length} 条记录（${blocked.slice(0, 3).map(record => record.name || "未命名").join("、")}）。请重新选择。`, { code: "missing_delete_blocked", details: blocked.map(record => record.localId) });
    }
    for (const entry of deletions) final[entry.entity] = final[entry.entity].filter(record => record.localId !== entry.localId);
    const returnedIds = new Set(DATA_SOURCE_KEYS.flatMap(entity => staging[entity].map(record => record.notionPageId)));
    const skippedReturnedIds = new Set((draft.summary.categoryIssues || []).filter(issue => choices.categories[issue.localId]?.action === "skip").map(issue => issue.pageId));
    for (const anomaly of draft.summary.anomalies || []) {
      const remote = staging[anomaly.entity]?.find(record => record.localId === anomaly.localId);
      if (remote?.notionPageId) skippedReturnedIds.add(remote.notionPageId);
    }
    for (const entity of MANAGED_MISSING) final[entity].forEach(record => { if (record.remoteMissing && returnedIds.has(record.notionPageId) && !skippedReturnedIds.has(record.notionPageId)) delete record.remoteMissing; });
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
    if (target.remoteMissing) throw new NotionApiError(`${label}“${target.name || "未命名"}”同步数据缺失，已停止上传。请先 Refresh 处理。`, { code: "dependency_remote_missing" });
    if (!target.notionPageId) throw new Error(`${label} Relation 目标尚未取得 Notion Page ID，已停止上传。`);
    return target.notionPageId;
  }

  async buildProperties(entity, record, connection, workspace, includePhotos = false) {
    if (record.workspaceId !== connection.databaseId) throw new Error("Relation 来源记录不属于当前 Workspace，已停止上传。");
    const ids = connection.propertyIds[entity];
    const pageId = (targetEntity, localId, label) => this.relationPageId(workspace, targetEntity, localId, label, connection.databaseId);
    if (entity === ENTITY.MAJOR) return { [ids.name]: titleValue(record.name), [ids.sort]: { number: record.sort ?? 0 } };
    const requiredPageId = (targetEntity, localId, label) => {
      if (!localId) throw new Error(`${label} Relation 为必需项，已停止上传。`);
      return pageId(targetEntity, localId, label);
    };
    if (entity === ENTITY.SUB) return { [ids.name]: titleValue(record.name), [ids.major]: relationValue([requiredPageId(ENTITY.MAJOR, record.majorLocalId, "所属大分类")]), [ids.sort]: { number: record.sort ?? 0 } };
    if (entity === ENTITY.ITEM) {
      const properties = {
        [ids.name]: titleValue(record.name), [ids.acquisitionDate]: dateValue(record.acquisitionDate), [ids.source]: textValue(record.source),
        [ids.sub]: relationValue([requiredPageId(ENTITY.SUB, record.subLocalId, "小分类")]),
        [ids.price]: { number: record.price === "" || record.price == null ? null : Number(record.price) },
        [ids.currency]: selectValue(record.currency), [ids.quantity]: { number: Number(record.quantity ?? 1) }
      };
      if (includePhotos) {
        const photos = workspace.photos.filter(photo => photo.workspaceId === connection.databaseId && record.photoIds?.includes(photo.localId)).sort((a,b) => a.order-b.order).slice(0,5);
        properties[ids.photos] = { files: photos.map(photo => photo.fileUploadId ? { type: "file_upload", file_upload: { id: photo.fileUploadId } } : photo.externalUrl ? { type: "external", name: photo.name, external: { url: photo.externalUrl } } : null).filter(Boolean) };
      }
      return properties;
    }
    return {
      [ids.name]: titleValue(record.name),
      [ids.mother]: relationValue([requiredPageId(ENTITY.ITEM, record.motherLocalId, "母本")]),
      [ids.father]: relationValue([requiredPageId(ENTITY.ITEM, record.fatherLocalId, "父本")]),
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

  uploadRecord(entity, localId, connection, options = {}) {
    const context = options.context;
    const key = `${context?.workspaceId || ""}:${entity}:${localId}`;
    if (this.recordUploads.has(key)) return this.recordUploads.get(key);
    const promise = this.performUploadRecord(entity, localId, connection, options);
    this.recordUploads.set(key, promise);
    return promise.finally(() => { if (this.recordUploads.get(key) === promise) this.recordUploads.delete(key); });
  }

  async performUploadRecord(entity, localId, connection, { force = false, visiting = new Set(), context } = {}) {
    guardContext(connection, context);
    const visitKey = `${entity}:${localId}`;
    if (visiting.has(visitKey)) throw new Error("检测到 Relation 循环，已停止上传。");
    visiting.add(visitKey);
    let workspace = await localDb.loadWorkspace(context.workspaceId);
    let record = workspace[entity].find(item => item.localId === localId && item.workspaceId === context.workspaceId);
    if (!record) throw new Error("找不到当前 Workspace 的待上传记录。");
    if (record.remoteMissing) throw new NotionApiError(`“${record.name || "未命名记录"}”同步数据缺失，当前记录已冻结。请先 Refresh 处理。`, { code: "record_remote_missing" });
    if (entity === ENTITY.ITEM) {
      const issue = categoryIssue(record, workspace);
      if (issue) throw new NotionApiError(`${issue.label}：${issue.detail}，已停止上传。`, { code: "category_remote_missing" });
    }
    for (const dependency of this.dependencies(entity, record)) {
      const target = workspace[dependency.entity].find(item => item.localId === dependency.localId && item.workspaceId === context.workspaceId);
      if (!target) throw new Error("Relation 目标不属于当前 Workspace，已停止上传。");
      if (!target.notionPageId) await this.uploadRecord(dependency.entity, dependency.localId, connection, { force, visiting, context });
    }
    guardContext(connection, context);
    workspace = await localDb.loadWorkspace(context.workspaceId);
    record = workspace[entity].find(item => item.localId === localId);
    if (record.notionPageId) {
      let remote;
      try { remote = await notionApi.retrievePage(record.notionPageId); }
      catch (error) {
        if (error.status !== 404 && error.code !== "object_not_found") throw error;
        const pages = await notionApi.queryAll(connection.dataSourceIds[entity]); guardContext(connection, context);
        if (!pages.some(page => page.id.replace(/-/g, "") === record.notionPageId.replace(/-/g, ""))) {
          throw new NotionApiError(`“${record.name || "未命名记录"}”已在完整远程列表中确认缺失。未重新创建，请执行 Refresh 选择处理方式。`, { code: "remote_missing_confirmed" });
        }
        throw error;
      }
      guardContext(connection, context);
      if (!force && record.syncBase && remote.last_edited_time !== record.syncBase) throw new NotionApiError(`“${record.name || "未命名记录"}”在 Notion 和本地都已变化，需要用户决定是否覆盖。`, { code: "local_remote_conflict", details: { remote, record } });
    }
    let properties = await this.buildProperties(entity, record, connection, workspace, false);
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
      if (includePhotos) properties = await this.buildProperties(entity, record, connection, workspace, true);
    }
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
    const results = { uploaded: 0, failed: [], skipped: [] };
    const queue = [];
    for (const entity of DATA_SOURCE_KEYS) {
      const records = (await localDb.getAll(entity, context.workspaceId)).filter(record => record.pending);
      records.forEach(record => queue.push({ entity, record }));
    }
    for (let index = 0; index < queue.length; index += 1) {
      const { entity, record } = queue[index];
      guardContext(connection, context); onProgress(`正在上传 ${APP_SCHEMA[entity].title}：${record.name || "未命名"}`);
      try { await this.uploadRecord(entity, record.localId, connection, { context }); results.uploaded += 1; }
      catch (error) {
        context.assertCurrent(); record.uploadError = error.message; await localDb.put(entity, record, context.workspaceId, context.sessionId);
        const target = ["record_remote_missing", "dependency_remote_missing", "category_remote_missing", "remote_missing_confirmed"].includes(error.code) ? results.skipped : results.failed;
        target.push({ entity, localId: record.localId, name: record.name, error });
        if (error.code === "local_remote_conflict") {
          queue.slice(index + 1).forEach(item => results.skipped.push({ entity: item.entity, localId: item.record.localId, name: item.record.name, error: new NotionApiError("前序记录存在冲突，本条未执行。", { code: "not_executed_after_conflict" }) }));
          return results;
        }
      }
    }
    return results;
  }
}

export const syncCoordinator = new SyncCoordinator();

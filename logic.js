export function buildCategoryOrder(majorCategories, subCategories) {
  const majors = [...majorCategories].sort((a,b) => a.sort-b.sort);
  return {
    majors: majors.map(record => record.localId),
    subs: Object.fromEntries(majors.map(major => [
      major.localId,
      subCategories.filter(sub => sub.majorLocalId === major.localId).sort((a,b) => a.sort-b.sort).map(sub => sub.localId)
    ]))
  };
}

export function moveIdInOrder(list, id, targetId, after = false) {
  const from = list.indexOf(id), target = list.indexOf(targetId);
  if (from < 0 || target < 0 || id === targetId) return false;
  list.splice(from, 1);
  list.splice(list.indexOf(targetId) + (after ? 1 : 0), 0, id);
  return true;
}

export function filterItemsByCategory(items, subCategories, { majorId = null, subId = null } = {}) {
  if (subId) return items.filter(item => item.subLocalId === subId);
  if (!majorId) return [...items];
  const allowed = new Set(subCategories.filter(sub => sub.majorLocalId === majorId).map(sub => sub.localId));
  return items.filter(item => allowed.has(item.subLocalId));
}

export const SYNC_STATUS = Object.freeze({
  MISSING: "remote-missing",
  PENDING: "pending",
  RELATION_PENDING: "relation-pending",
  SYNCED: "synced"
});

export function categoryIssue(item, workspace) {
  const sub = workspace.subCategories.find(record => record.localId === item.subLocalId);
  if (!sub) return { code: "missing-sub", label: "所用分类缺失", detail: "所用小分类不存在" };
  if (sub.remoteMissing) return { code: "remote-missing-sub", label: "所用分类缺失", detail: `小分类“${sub.name || "未命名"}”同步数据缺失` };
  const major = workspace.majorCategories.find(record => record.localId === sub.majorLocalId);
  if (!major) return { code: "missing-major", label: "所用分类缺失", detail: "所属大分类不存在" };
  if (major.remoteMissing) return { code: "remote-missing-major", label: "所用分类缺失", detail: `大分类“${major.name || "未命名"}”同步数据缺失` };
  return null;
}

export function deriveSyncStatus(entity, record, workspace) {
  if (record.remoteMissing) return { code: SYNC_STATUS.MISSING, label: "同步数据缺失" };
  if (record.dirty || record.pending) return { code: SYNC_STATUS.PENDING, label: "待上传" };
  if (entity === "items") {
    const sub = workspace.subCategories.find(item => item.localId === record.subLocalId);
    const major = sub && workspace.majorCategories.find(item => item.localId === sub.majorLocalId);
    if (sub?.dirty || sub?.pending || major?.dirty || major?.pending) return { code: SYNC_STATUS.RELATION_PENDING, label: "关联数据待上传" };
  }
  return { code: SYNC_STATUS.SYNCED, label: "已同步" };
}

export function matchesSyncFilter(item, workspace, filter = "all") {
  if (filter === "all") return true;
  const status = deriveSyncStatus("items", item, workspace).code;
  if (categoryIssue(item, workspace) && !item.remoteMissing && !(item.dirty || item.pending)) return false;
  if (filter === SYNC_STATUS.SYNCED) return status === filter && !categoryIssue(item, workspace);
  return status === filter;
}

export function categoryDeleteBlock(entity, localId, workspace) {
  if (entity === "majorCategories") {
    const records = workspace.subCategories.filter(record => record.majorLocalId === localId);
    return records.length ? { blocked: true, count: records.length, records, reason: `仍包含 ${records.length} 个小分类` } : { blocked: false, count: 0, records: [] };
  }
  if (entity === "subCategories") {
    const records = workspace.items.filter(record => record.subLocalId === localId);
    return records.length ? { blocked: true, count: records.length, records, reason: `仍被 ${records.length} 条具体资料使用` } : { blocked: false, count: 0, records: [] };
  }
  return { blocked: false, count: 0, records: [] };
}

export function describeRecoveries(recoveries) {
  return recoveries.map(recovery => {
    const id = recovery.targetDatabaseId || recovery.databaseId || null;
    const displayId = id || "未知目标";
    return {
      recovery,
      id,
      localId: recovery.localId || null,
      name: String(recovery.databaseName || "").trim() || "未命名 Database",
      status: "初始化未完成",
      shortId: displayId.length > 16 ? `${displayId.slice(0,8)}…${displayId.slice(-6)}` : displayId,
      time: recovery.updatedAt || recovery.createdAt || recovery.connectedAt || "时间未知",
      canResume: Boolean(id)
    };
  });
}

function safeError(error) {
  if (!error) return null;
  return {
    status: Number(error.status || 0),
    code: String(error.code || "unknown_error"),
    message: String(error.message || ""),
    details: typeof error.details === "string" ? error.details : error.details == null ? null : JSON.stringify(error.details)
  };
}

export function buildLocalDiagnostics({ connection, recoveries, staging, workspace, sessionId, connectionBusy, uploadBusy }) {
  const storeNames = ["majorCategories", "subCategories", "items", "pairings", "photos"];
  const stores = Object.fromEntries(storeNames.map(name => [name, (workspace?.[name] || []).length]));
  const scopedRecords = storeNames.flatMap(name => workspace?.[name] || []);
  const stagingByType = {};
  staging.forEach(record => {
    const type = String(record.type || "unknown");
    stagingByType[type] = (stagingByType[type] || 0) + 1;
  });
  return {
    generatedAt: new Date().toISOString(),
    currentConnection: {
      activeDatabaseId: connection?.databaseId || null,
      databaseName: connection?.databaseName || "未命名 Database",
      pwaStatus: connection ? "正常使用" : "未连接",
      currentWorkspaceId: connection?.databaseId || null
    },
    initializationRecovery: {
      scope: "本机全部 initialization-recovery staging 记录",
      count: recoveries.length,
      records: recoveries.map(recovery => ({
        localId: recovery.localId || null,
        targetDatabaseId: recovery.targetDatabaseId || recovery.databaseId || null,
        databaseName: recovery.databaseName || "未命名 Database",
        status: "初始化未完成",
        parentPageId: recovery.parentPageId || null,
        createdAt: recovery.createdAt || null,
        updatedAt: recovery.updatedAt || null,
        dataSourceIds: { ...(recovery.dataSourceIds || {}) },
        stage: recovery.stage || null,
        progressMessage: recovery.progressMessage || null,
        lastError: safeError(recovery.lastError)
      }))
    },
    staging: {
      scope: "本机全部 staging 记录",
      total: staging.length,
      byType: stagingByType
    },
    workspaceSync: {
      scope: connection ? `当前 Workspace ${connection.databaseId}` : "无当前 Workspace",
      stores,
      photoCount: stores.photos,
      pendingCount: scopedRecords.filter(record => record.pending).length,
      dirtyCount: scopedRecords.filter(record => record.dirty).length,
      sessionId: sessionId || null,
      connectionBusy: Boolean(connectionBusy),
      uploadBusy: Boolean(uploadBusy)
    }
  };
}

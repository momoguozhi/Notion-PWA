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

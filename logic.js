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
    const id = recovery.targetDatabaseId || recovery.databaseId || "未知目标";
    return {
      recovery,
      id,
      shortId: id.length > 16 ? `${id.slice(0,8)}…${id.slice(-6)}` : id,
      time: recovery.updatedAt || recovery.connectedAt || "时间未知"
    };
  });
}

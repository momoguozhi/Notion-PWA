import { DATA_SOURCE_KEYS, ENTITY, SCHEMA_VERSION } from "./schema.js";

const DB_NAME = "notion-pwa-v041";
const LEGACY_DB_NAME = "notion-pwa-v03";
const DB_VERSION = 1;
const BUSINESS_STORES = [...DATA_SOURCE_KEYS, "photos"];
const STORES = [...BUSINESS_STORES, "syncMeta", "connectionConfig", "credentialVault", "staging"];

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("本地事务已中止。"));
  });
}

function deleteMatching(store, predicate) {
  return new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      if (predicate(cursor.value)) cursor.delete();
      cursor.continue();
    };
  });
}

function replaceMatching(store, predicate, values) {
  return new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        if (predicate(cursor.value)) cursor.delete();
        cursor.continue();
        return;
      }
      values.forEach(value => store.put(value));
      resolve();
    };
  });
}

class LocalDatabase {
  constructor() {
    this.db = null;
    this.workspaceId = null;
    this.activeSessionId = null;
    this.writeTail = Promise.resolve();
    this.switchInProgress = false;
  }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        STORES.forEach(name => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "localId" });
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  setWorkspace(workspaceId) { this.workspaceId = workspaceId || null; }
  setActiveSession(sessionId) { this.activeSessionId = sessionId || null; }

  queueWorkspaceWrite(sessionId, operation) {
    const expectedSessionId = sessionId || this.activeSessionId;
    if (this.switchInProgress) return Promise.reject(new Error("连接切换正在提交，当前 Workspace 写入已取消。"));
    const run = async () => {
      if (!expectedSessionId || expectedSessionId !== this.activeSessionId) {
        throw new Error("连接会话已失效，旧异步写入已取消。");
      }
      return operation();
    };
    const result = this.writeTail.then(run, run);
    this.writeTail = result.catch(() => {});
    return result;
  }

  queueExclusiveWrite(operation) {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.catch(() => {});
    return result;
  }

  requireWorkspace(workspaceId = this.workspaceId) {
    if (!workspaceId) throw new Error("当前没有 active Database Workspace。");
    return workspaceId;
  }

  store(name, mode = "readonly") {
    if (!STORES.includes(name)) throw new Error(`未知本地存储：${name}`);
    return this.db.transaction(name, mode).objectStore(name);
  }

  request(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(name, localId) {
    const value = await this.request(this.store(name).get(localId));
    if (BUSINESS_STORES.includes(name) && value?.workspaceId !== this.workspaceId) return undefined;
    return value;
  }

  async getAll(name, workspaceId = this.workspaceId) {
    const values = await this.request(this.store(name).getAll());
    if (!BUSINESS_STORES.includes(name)) return values;
    const active = this.requireWorkspace(workspaceId);
    return values.filter(value => value.workspaceId === active);
  }

  async put(name, value, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    let stored = value;
    if (BUSINESS_STORES.includes(name)) {
      const active = this.requireWorkspace(workspaceId);
      if (value.workspaceId && value.workspaceId !== active) throw new Error("已阻止跨 Workspace 写入本地业务数据。");
      stored = { ...value, workspaceId: active };
      return this.queueWorkspaceWrite(sessionId, () => this.request(this.store(name, "readwrite").put(stored)));
    }
    return this.request(this.store(name, "readwrite").put(stored));
  }

  async remove(name, localId, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    if (BUSINESS_STORES.includes(name)) {
      const active = this.requireWorkspace(workspaceId);
      return this.queueWorkspaceWrite(sessionId, async () => {
        const existing = await this.request(this.store(name).get(localId));
        if (!existing || existing.workspaceId !== active) return;
        return this.request(this.store(name, "readwrite").delete(localId));
      });
    }
    return this.request(this.store(name, "readwrite").delete(localId));
  }

  async loadWorkspace(workspaceId = this.workspaceId) {
    if (!workspaceId) return { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
    const [majorCategories, subCategories, items, pairings, photos] = await Promise.all([
      this.getAll(ENTITY.MAJOR, workspaceId), this.getAll(ENTITY.SUB, workspaceId), this.getAll(ENTITY.ITEM, workspaceId),
      this.getAll(ENTITY.PAIRING, workspaceId), this.getAll("photos", workspaceId)
    ]);
    return { majorCategories, subCategories, items, pairings, photos };
  }

  async replaceWorkspaceStore(name, values, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    if (!BUSINESS_STORES.includes(name)) throw new Error("replaceWorkspaceStore 只允许业务 store。");
    return this.queueWorkspaceWrite(sessionId, async () => {
      const transaction = this.db.transaction(name, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(name);
      await replaceMatching(store, value => value.workspaceId === active, values.map(value => ({ ...value, workspaceId: active })));
      await done;
    });
  }

  async applyRefreshWorkspace(workspace, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    return this.queueWorkspaceWrite(sessionId, async () => {
      const transaction = this.db.transaction([...BUSINESS_STORES, "syncMeta", "staging"], "readwrite");
      const done = transactionDone(transaction);
      const replacements = BUSINESS_STORES.map(name => replaceMatching(
        transaction.objectStore(name),
        value => value.workspaceId === active,
        (workspace[name] || []).map(value => ({ ...value, workspaceId: active }))
      ));
      transaction.objectStore("syncMeta").put({ localId: `${active}:last-refresh`, workspaceId: active, key: "last-refresh", completedAt: new Date().toISOString() });
      transaction.objectStore("staging").delete(`remote-refresh:${active}`);
      await Promise.all(replacements);
      await done;
    });
  }

  async saveItemWithPhotos(item, photos, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    if (item.workspaceId && item.workspaceId !== active) throw new Error("已阻止跨 Workspace 保存 Item。");
    if (photos.some(photo => photo.workspaceId && photo.workspaceId !== active)) throw new Error("已阻止跨 Workspace 保存照片。");
    return this.queueWorkspaceWrite(sessionId, async () => {
      const transaction = this.db.transaction([ENTITY.ITEM, "photos"], "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(ENTITY.ITEM).put({ ...item, workspaceId: active });
      await Promise.all([replaceMatching(
        transaction.objectStore("photos"),
        value => value.workspaceId === active && value.itemLocalId === item.localId,
        photos.map(photo => ({ ...photo, workspaceId: active, itemLocalId: item.localId }))
      ), done]);
    });
  }

  async deleteItemWithPhotos(localId, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    return this.queueWorkspaceWrite(sessionId, async () => {
      const transaction = this.db.transaction([ENTITY.ITEM, "photos"], "readwrite");
      const done = transactionDone(transaction);
      await Promise.all([
        deleteMatching(transaction.objectStore(ENTITY.ITEM), value => value.workspaceId === active && value.localId === localId),
        deleteMatching(transaction.objectStore("photos"), value => value.workspaceId === active && value.itemLocalId === localId),
        done
      ]);
    });
  }

  async saveCategorySort(majorCategories, subCategories, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    const records = [...majorCategories, ...subCategories];
    if (records.some(record => record.workspaceId && record.workspaceId !== active)) throw new Error("已阻止跨 Workspace 保存分类排序。");
    return this.queueWorkspaceWrite(sessionId, async () => {
      const transaction = this.db.transaction([ENTITY.MAJOR, ENTITY.SUB], "readwrite");
      const done = transactionDone(transaction);
      majorCategories.forEach(record => transaction.objectStore(ENTITY.MAJOR).put({ ...record, workspaceId: active }));
      subCategories.forEach(record => transaction.objectStore(ENTITY.SUB).put({ ...record, workspaceId: active }));
      await done;
    });
  }

  async saveConnection(config) {
    await this.put("connectionConfig", { ...config, localId: "active", schemaVersion: SCHEMA_VERSION });
  }

  async getConnection() {
    const config = await this.get("connectionConfig", "active");
    return config ? { ...config, schemaVersion: SCHEMA_VERSION } : null;
  }

  async hasPending(workspaceId = this.workspaceId) {
    if (!workspaceId) return false;
    const workspace = await this.loadWorkspace(workspaceId);
    return [...workspace.majorCategories, ...workspace.subCategories, ...workspace.items, ...workspace.pairings, ...workspace.photos]
      .some(record => record.dirty || record.pending);
  }

  async commitConnectionSwitch(oldWorkspaceId, newConnection, nextSessionId) {
    this.setActiveSession(nextSessionId);
    this.switchInProgress = true;
    return this.queueExclusiveWrite(async () => {
      try {
        const transaction = this.db.transaction("connectionConfig", "readwrite");
        const done = transactionDone(transaction);
        const connectionStore = transaction.objectStore("connectionConfig");
        if (newConnection) connectionStore.put({ ...newConnection, localId: "active", schemaVersion: SCHEMA_VERSION });
        else connectionStore.delete("active");
        await done;
      } finally {
        this.switchInProgress = false;
      }
    });
  }

  async setSyncMeta(key, value, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    await this.queueWorkspaceWrite(sessionId, () => this.request(this.store("syncMeta", "readwrite").put({ localId: `${active}:${key}`, workspaceId: active, key, ...value })));
  }

  async getSyncMeta(key, workspaceId = this.workspaceId) {
    const active = this.requireWorkspace(workspaceId);
    return this.get("syncMeta", `${active}:${key}`);
  }

  async putRemoteRefresh(staging, summary, workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    await this.queueWorkspaceWrite(sessionId, () => this.request(this.store("staging", "readwrite").put({ localId: `remote-refresh:${active}`, type: "remote-refresh", workspaceId: active, staging, summary, fetchedAt: new Date().toISOString() })));
  }

  async removeRemoteRefresh(workspaceId = this.workspaceId, sessionId = this.activeSessionId) {
    const active = this.requireWorkspace(workspaceId);
    await this.queueWorkspaceWrite(sessionId, () => this.request(this.store("staging", "readwrite").delete(`remote-refresh:${active}`)));
  }

  initializationRecoveryId(databaseId) { return `initialization-recovery:${databaseId}`; }
  async getStagingRecords() { return this.getAll("staging"); }
  async getInitializationRecoveries() {
    return (await this.getStagingRecords()).filter(value => value.type === "initialization-recovery");
  }
  async getInitializationRecovery(localId) {
    const value = await this.get("staging", localId);
    return value?.type === "initialization-recovery" ? value : null;
  }
  async putInitializationRecoveryRecord(localId, databaseId, partial) {
    if (!databaseId) throw new Error("初始化恢复点缺少目标 Database ID。");
    const recordId = localId || this.initializationRecoveryId(databaseId);
    const existing = await this.get("staging", recordId);
    const now = new Date().toISOString();
    await this.put("staging", {
      ...(existing?.type === "initialization-recovery" ? existing : {}),
      ...partial,
      localId: recordId,
      type: "initialization-recovery",
      databaseId,
      targetDatabaseId: databaseId,
      createdAt: existing?.createdAt || partial.createdAt || now,
      updatedAt: now
    });
  }
  async putInitializationRecovery(databaseId, partial) {
    return this.putInitializationRecoveryRecord(this.initializationRecoveryId(databaseId), databaseId, partial);
  }
  async removeInitializationRecoveryRecord(localId) { await this.remove("staging", localId); }
  async removeInitializationRecovery(databaseId) { await this.removeInitializationRecoveryRecord(this.initializationRecoveryId(databaseId)); }

  async migrateLegacyConfiguration() {
    if (!indexedDB.databases) return { checked: false, reason: "当前浏览器不支持安全枚举旧 IndexedDB。" };
    const databases = await indexedDB.databases();
    if (!databases.some(database => database.name === LEGACY_DB_NAME)) return { checked: true, migrated: false };
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const readLegacy = async (storeName, key) => {
        if (!legacy.objectStoreNames.contains(storeName)) return undefined;
        const transaction = legacy.transaction(storeName, "readonly");
        return new Promise((resolve, reject) => {
          const request = transaction.objectStore(storeName).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      };
      const [vault, connection] = await Promise.all([
        readLegacy("credentialVault", "notion-token"), readLegacy("connectionConfig", "active")
      ]);
      const existingVault = await this.get("credentialVault", "notion-token");
      const existingConnection = await this.getConnection();
      const transaction = this.db.transaction(["credentialVault", "connectionConfig"], "readwrite");
      const done = transactionDone(transaction);
      if (vault && !existingVault) transaction.objectStore("credentialVault").put(vault);
      if (connection && !existingConnection) transaction.objectStore("connectionConfig").put({ ...connection, localId: "active", schemaVersion: SCHEMA_VERSION });
      await done;
      return { checked: true, migrated: Boolean((vault && !existingVault) || (connection && !existingConnection)) };
    } finally { legacy.close(); }
  }
}

export const localDb = new LocalDatabase();

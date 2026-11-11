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
  constructor() { this.db = null; this.workspaceId = null; }

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

  async put(name, value, workspaceId = this.workspaceId) {
    let stored = value;
    if (BUSINESS_STORES.includes(name)) {
      const active = this.requireWorkspace(workspaceId);
      if (value.workspaceId && value.workspaceId !== active) throw new Error("已阻止跨 Workspace 写入本地业务数据。");
      stored = { ...value, workspaceId: active };
    }
    return this.request(this.store(name, "readwrite").put(stored));
  }

  async remove(name, localId, workspaceId = this.workspaceId) {
    if (BUSINESS_STORES.includes(name)) {
      const existing = await this.request(this.store(name).get(localId));
      if (!existing || existing.workspaceId !== this.requireWorkspace(workspaceId)) return;
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

  async replaceWorkspaceStore(name, values, workspaceId = this.workspaceId) {
    const active = this.requireWorkspace(workspaceId);
    if (!BUSINESS_STORES.includes(name)) throw new Error("replaceWorkspaceStore 只允许业务 store。");
    const transaction = this.db.transaction(name, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(name);
    await replaceMatching(store, value => value.workspaceId === active, values.map(value => ({ ...value, workspaceId: active })));
    await done;
  }

  async applyRefreshWorkspace(workspace, workspaceId = this.workspaceId) {
    const active = this.requireWorkspace(workspaceId);
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
  }

  async saveConnection(config) {
    await this.put("connectionConfig", { ...config, localId: "active", schemaVersion: SCHEMA_VERSION });
  }

  async getConnection() { return this.get("connectionConfig", "active"); }

  async hasPending(workspaceId = this.workspaceId) {
    if (!workspaceId) return false;
    const workspace = await this.loadWorkspace(workspaceId);
    return [...workspace.majorCategories, ...workspace.subCategories, ...workspace.items, ...workspace.pairings, ...workspace.photos]
      .some(record => record.dirty || record.pending);
  }

  async commitConnectionSwitch(oldWorkspaceId, newConnection) {
    const transaction = this.db.transaction([...BUSINESS_STORES, "syncMeta", "staging", "connectionConfig"], "readwrite");
    const done = transactionDone(transaction);
    const deletes = [];
    if (oldWorkspaceId) {
      for (const name of BUSINESS_STORES) deletes.push(deleteMatching(transaction.objectStore(name), value => value.workspaceId === oldWorkspaceId));
      deletes.push(deleteMatching(transaction.objectStore("syncMeta"), value => value.workspaceId === oldWorkspaceId));
      deletes.push(deleteMatching(transaction.objectStore("staging"), value => value.type === "remote-refresh" && value.workspaceId === oldWorkspaceId));
    }
    const connectionStore = transaction.objectStore("connectionConfig");
    if (newConnection) connectionStore.put({ ...newConnection, localId: "active", schemaVersion: SCHEMA_VERSION });
    else connectionStore.delete("active");
    await Promise.all(deletes);
    await done;
  }

  async setSyncMeta(key, value, workspaceId = this.workspaceId) {
    const active = this.requireWorkspace(workspaceId);
    await this.put("syncMeta", { localId: `${active}:${key}`, workspaceId: active, key, ...value });
  }

  async getSyncMeta(key, workspaceId = this.workspaceId) {
    const active = this.requireWorkspace(workspaceId);
    return this.get("syncMeta", `${active}:${key}`);
  }

  async putRemoteRefresh(staging, summary, workspaceId = this.workspaceId) {
    const active = this.requireWorkspace(workspaceId);
    await this.put("staging", { localId: `remote-refresh:${active}`, type: "remote-refresh", workspaceId: active, staging, summary, fetchedAt: new Date().toISOString() });
  }

  async removeRemoteRefresh(workspaceId = this.workspaceId) {
    const active = this.requireWorkspace(workspaceId);
    await this.remove("staging", `remote-refresh:${active}`);
  }

  initializationRecoveryId(databaseId) { return `initialization-recovery:${databaseId}`; }
  async getInitializationRecoveries() {
    return (await this.getAll("staging")).filter(value => value.type === "initialization-recovery" && value.targetDatabaseId);
  }
  async putInitializationRecovery(databaseId, partial) {
    if (!databaseId) throw new Error("初始化恢复点缺少目标 Database ID。");
    await this.put("staging", { localId: this.initializationRecoveryId(databaseId), type: "initialization-recovery", targetDatabaseId: databaseId, ...partial, updatedAt: new Date().toISOString() });
  }
  async removeInitializationRecovery(databaseId) { await this.remove("staging", this.initializationRecoveryId(databaseId)); }

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

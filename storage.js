import { DATA_SOURCE_KEYS, ENTITY, SCHEMA_VERSION } from "./schema.js";

const DB_NAME = "notion-pwa-v03";
const DB_VERSION = 1;
const STORES = [...DATA_SOURCE_KEYS, "photos", "syncMeta", "connectionConfig", "credentialVault", "staging"];

class LocalDatabase {
  constructor() { this.db = null; }

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

  async get(name, localId) { return this.request(this.store(name).get(localId)); }
  async getAll(name) { return this.request(this.store(name).getAll()); }
  async put(name, value) { return this.request(this.store(name, "readwrite").put(value)); }
  async remove(name, localId) { return this.request(this.store(name, "readwrite").delete(localId)); }
  async clear(name) { return this.request(this.store(name, "readwrite").clear()); }

  async replaceAll(name, values) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(name, "readwrite");
      const store = transaction.objectStore(name);
      store.clear();
      values.forEach(value => store.put(value));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async loadWorkspace() {
    const [majorCategories, subCategories, items, pairings, photos] = await Promise.all([
      this.getAll(ENTITY.MAJOR), this.getAll(ENTITY.SUB), this.getAll(ENTITY.ITEM),
      this.getAll(ENTITY.PAIRING), this.getAll("photos")
    ]);
    return { majorCategories, subCategories, items, pairings, photos };
  }

  async saveConnection(config) {
    await this.put("connectionConfig", { ...config, localId: "active", schemaVersion: SCHEMA_VERSION });
  }

  async getConnection() { return this.get("connectionConfig", "active"); }

  async clearConnection() {
    await Promise.all([
      this.remove("connectionConfig", "active"),
      this.remove("credentialVault", "notion-token"),
      this.clear("syncMeta"),
      this.clear("staging")
    ]);
  }

  async setSyncMeta(key, value) { await this.put("syncMeta", { localId: key, ...value }); }
  async getSyncMeta(key) { return this.get("syncMeta", key); }
}

export const localDb = new LocalDatabase();

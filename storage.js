import { DATA_SOURCE_KEYS, ENTITY, SCHEMA_VERSION } from "./schema.js";

const DB_NAME = "notion-pwa-v03";
const DB_VERSION = 2;
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
    await this.migrateV04StatusRecords();
    return this.db;
  }

  async migrateV04StatusRecords() {
    const items = await this.getAll(ENTITY.ITEM);
    const legacyItems = items.filter(item => !item.statusLocalId && typeof item.status === "string" && item.status.trim());
    if (!legacyItems.length) return;
    const statuses = await this.getAll(ENTITY.STATUS);
    const colorByName = { "在库": "green", "培育中": "blue", "已售出": "purple", "已枯失": "red", "其他": "gray" };
    for (const item of legacyItems) {
      const name = item.status.trim();
      let status = statuses.find(record => record.name === name);
      if (!status) {
        const now = new Date().toISOString();
        status = {
          localId: crypto.randomUUID(), entity: ENTITY.STATUS, name,
          color: colorByName[name] || "gray", sort: statuses.length * 10 + 10,
          notionPageId: null, notionPageUrl: null, notionUniqueId: null,
          dirty: true, pending: true, lastRemoteEdit: null, syncBase: null,
          uploadError: null, createdAt: now, updatedAt: now
        };
        statuses.push(status);
        await this.put(ENTITY.STATUS, status);
      }
      item.statusLocalId = status.localId;
      delete item.status;
      item.dirty = true;
      item.pending = true;
      item.updatedAt = new Date().toISOString();
      await this.put(ENTITY.ITEM, item);
    }
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

  async loadWorkspace(includeDeleted = false) {
    const [majorCategories, subCategories, statuses, items, pairings, photos] = await Promise.all([
      this.getAll(ENTITY.MAJOR), this.getAll(ENTITY.SUB), this.getAll(ENTITY.STATUS), this.getAll(ENTITY.ITEM),
      this.getAll(ENTITY.PAIRING), this.getAll("photos")
    ]);
    const visible = records => includeDeleted ? records : records.filter(record => !record.deleted);
    return {
      majorCategories: visible(majorCategories), subCategories: visible(subCategories), statuses: visible(statuses),
      items: visible(items), pairings: visible(pairings), photos
    };
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

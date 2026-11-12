import { APP_SCHEMA, DATA_SOURCE_KEYS, NOTION_VERSION, SCHEMA_VERSION, baseProperties, relationProperties } from "./schema.js";
import { credentials } from "./credentials.js";

const DEFAULT_API_BASE = "https://api.notion.com/v1";

export class NotionApiError extends Error {
  constructor(message, { status = 0, code = "network_error", details = null } = {}) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorMessage(status, code, fallback) {
  if (status === 401 || code === "unauthorized") return "Notion Integration Token 无效或已撤销。";
  if (status === 403 || code === "restricted_resource") return "Integration 没有访问该 Page 或 Database 的权限，请先在 Notion 中授权。";
  if (status === 404 || code === "object_not_found") return "找不到指定的 Notion 资源，或当前 Integration 没有访问权限。请确认 URL / ID 以及 Notion 中的 Connection 授权。";
  if (status === 409 || code === "conflict_error") return "Notion 返回冲突，请刷新远程状态后再决定如何处理。";
  if (status === 429 || code === "rate_limited") return "Notion API 请求过于频繁，请稍后重试。";
  return fallback || `Notion API 请求失败（${status || "网络错误"}）。`;
}

export function extractNotionId(input) {
  const text = String(input || "").trim();
  const standard = /(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[^0-9a-f])/ig;
  const compact = /(?:^|[^0-9a-f])([0-9a-f]{32})(?=$|[^0-9a-f])/ig;
  const matches = [...text.matchAll(standard), ...text.matchAll(compact)].sort((a, b) => a.index - b.index);
  const raw = matches.at(-1)?.[1];
  if (!raw) throw new Error("无法从输入内容识别 Notion ID。");
  const id = raw.replace(/-/g, "").toLowerCase();
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

function plainTitle(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => part.plain_text || part.text?.content || "").join("");
  return "";
}

function databaseTitle(database) {
  return plainTitle(database?.title).trim() || "未命名 Database";
}

function compactId(value) { return String(value || "").replace(/-/g, "").toLowerCase(); }

class NotionApiAdapter {
  constructor() { this.apiBase = DEFAULT_API_BASE; }

  async request(path, { method = "GET", body, rawBody, retry = 0 } = {}) {
    const headers = {
      Authorization: `Bearer ${credentials.getToken()}`,
      "Notion-Version": NOTION_VERSION
    };
    if (!rawBody) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        method, headers, body: rawBody || (body === undefined ? undefined : JSON.stringify(body))
      });
    } catch (cause) {
      throw new NotionApiError("无法连接 Notion API。若浏览器阻止跨域请求，需要部署可信的同源代理；本地数据不会丢失。", { details: cause.message });
    }
    if (response.status === 429 && retry < 2) {
      const delay = Math.min(5000, Math.max(1000, Number(response.headers.get("Retry-After") || 1) * 1000));
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.request(path, { method, body, rawBody, retry: retry + 1 });
    }
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const code = payload?.code || "http_error";
      throw new NotionApiError(errorMessage(response.status, code, payload?.message), {
        status: response.status, code, details: payload?.message || payload
      });
    }
    return payload;
  }

  retrieveDatabase(databaseId) { return this.request(`/databases/${extractNotionId(databaseId)}`); }
  retrieveDataSource(dataSourceId) { return this.request(`/data_sources/${extractNotionId(dataSourceId)}`); }
  retrievePage(pageId) { return this.request(`/pages/${extractNotionId(pageId)}`); }

  async createDataSource(databaseId, entityKey) {
    return this.request("/data_sources", {
      method: "POST",
      body: {
        parent: { type: "database_id", database_id: databaseId },
        title: [{ type: "text", text: { content: APP_SCHEMA[entityKey].title } }],
        properties: baseProperties(entityKey)
      }
    });
  }

  async updateRelations(entityKey, dataSourceIds) {
    const properties = relationProperties(entityKey, dataSourceIds);
    if (!Object.keys(properties).length) return;
    const source = await this.retrieveDataSource(dataSourceIds[entityKey]);
    const changes = {};
    for (const [name, expected] of Object.entries(properties)) {
      const actual = Object.values(source.properties || {}).find(property => property.name === name);
      if (actual?.type !== "relation" || compactId(actual.relation?.data_source_id) !== compactId(expected.relation.data_source_id)) changes[name] = expected;
    }
    if (Object.keys(changes).length) await this.request(`/data_sources/${dataSourceIds[entityKey]}`, {
      method: "PATCH", body: { properties: changes }
    });
  }

  assertDataSourceParent(source, databaseId) {
    const parentId = source?.parent?.database_id;
    if (parentId && compactId(parentId) !== compactId(databaseId)) {
      throw new NotionApiError("Recovery 中记录的 Data Source 不属于目标 Database，已停止以避免跨 Database 修改。", {
        code: "database_identity_mismatch", details: { targetDatabaseId: databaseId, dataSourceId: source.id, parentDatabaseId: parentId }
      });
    }
  }

  async ensureDataSourceTitle(source, entityKey) {
    const expected = APP_SCHEMA[entityKey].title;
    if (this.dataSourceTitle(source) === expected) return source;
    return this.request(`/data_sources/${source.id}`, { method: "PATCH", body: { title: [{ type: "text", text: { content: expected } }] } });
  }

  async initializeDatabase(parentPageInput, databaseName, progress = () => {}) {
    const parentPageId = extractNotionId(parentPageInput);
    const name = String(databaseName || "").trim();
    if (!name) throw new Error("Database 名称不能为空。");
    let context = { databaseName: name, parentPageId, stage: "create-database", progressMessage: "正在创建 Database…" };
    const report = async (message, patch = {}) => {
      context = { ...context, ...patch, progressMessage: message };
      await progress(message, { ...context, dataSourceIds: { ...(context.dataSourceIds || {}) } });
    };
    try {
      await report("正在创建 Database 和初始大分类 Data Source…");
      const database = await this.request("/databases", {
        method: "POST",
        body: {
          parent: { type: "page_id", page_id: parentPageId },
          title: [{ type: "text", text: { content: name } }],
          initial_data_source: { properties: baseProperties(DATA_SOURCE_KEYS[0]) }
        }
      });
      const databaseId = database.id;
      const dataSourceIds = {};
      await report("Database 已创建，正在确认初始 Data Source…", { databaseId, targetDatabaseId: databaseId, databaseUrl: database.url || null, dataSourceIds, stage: "confirm-initial-data-source" });
      const initial = database.data_sources?.[0];
      if (!initial?.id) throw new NotionApiError("Database 已创建，但响应中缺少初始 Data Source ID；目标 Database recovery 已保留。", { code: "initialization_interrupted" });
      dataSourceIds[DATA_SOURCE_KEYS[0]] = initial.id;
      await report("正在确认大分类 Data Source 名称…", { dataSourceIds: { ...dataSourceIds }, stage: `ensure-data-source:${DATA_SOURCE_KEYS[0]}` });
      const initialSource = await this.retrieveDataSource(initial.id);
      this.assertDataSourceParent(initialSource, databaseId);
      await this.ensureDataSourceTitle(initialSource, DATA_SOURCE_KEYS[0]);
      for (const entityKey of DATA_SOURCE_KEYS.slice(1)) {
        await report(`正在创建 ${APP_SCHEMA[entityKey].title} Data Source…`, { dataSourceIds: { ...dataSourceIds }, stage: `create-data-source:${entityKey}` });
        const dataSource = await this.createDataSource(databaseId, entityKey);
        this.assertDataSourceParent(dataSource, databaseId);
        dataSourceIds[entityKey] = dataSource.id;
        await report(`已创建 ${APP_SCHEMA[entityKey].title}，恢复点已更新。`, { dataSourceIds: { ...dataSourceIds } });
      }
      for (const entityKey of DATA_SOURCE_KEYS) {
        await report(`正在核对 ${APP_SCHEMA[entityKey].title} Relation…`, { dataSourceIds: { ...dataSourceIds }, stage: `ensure-relations:${entityKey}` });
        await this.updateRelations(entityKey, dataSourceIds);
      }
      await report("正在重新读取并验证最终 Schema…", { dataSourceIds: { ...dataSourceIds }, stage: "validate-schema" });
      const connection = await this.buildConnection(databaseId, dataSourceIds, database.url || null, name);
      await report("Schema 验证完成，等待提交本机 connection…", { dataSourceIds: { ...dataSourceIds }, stage: "schema-verified" });
      return connection;
    } catch (error) {
      error.initializationContext = { ...context, dataSourceIds: { ...(context.dataSourceIds || {}) } };
      throw error;
    }
  }

  async resumeInitialization(partial, progress = () => {}) {
    const databaseId = extractNotionId(partial.targetDatabaseId || partial.databaseId);
    let context = { ...partial, databaseId, targetDatabaseId: databaseId, stage: "retrieve-target-database", progressMessage: "正在读取 recovery 目标 Database…" };
    const report = async (message, patch = {}) => {
      context = { ...context, ...patch, progressMessage: message };
      await progress(message, { ...context, dataSourceIds: { ...(context.dataSourceIds || {}) } });
    };
    try {
      await report("正在按 Database ID 读取 recovery 目标…");
      const database = await this.retrieveDatabase(databaseId);
      const name = partial.databaseName || databaseTitle(database);
      const summaries = database.data_sources || [];
      const dataSourceIds = { ...(partial.dataSourceIds || {}) };
      context = { ...context, databaseName: name, databaseUrl: partial.databaseUrl || database.url || null, dataSourceIds };
      for (const entityKey of DATA_SOURCE_KEYS) {
        let source = null;
        if (dataSourceIds[entityKey]) {
          try {
            source = await this.retrieveDataSource(dataSourceIds[entityKey]);
            this.assertDataSourceParent(source, databaseId);
          } catch (error) {
            if (error.status !== 404) throw error;
            delete dataSourceIds[entityKey];
          }
        }
        if (!source) {
          const matches = summaries.filter(summary => this.dataSourceTitle(summary) === APP_SCHEMA[entityKey].title);
          if (matches.length > 1) throw new NotionApiError(`目标 Database 内存在多个“${APP_SCHEMA[entityKey].title}”Data Source，无法安全恢复。`, { code: "schema_mismatch" });
          if (matches.length === 1) {
            source = await this.retrieveDataSource(matches[0].id);
            this.assertDataSourceParent(source, databaseId);
            dataSourceIds[entityKey] = source.id;
          }
        }
        if (source) {
          await report(`恢复初始化：复用目标 Database 内已有的 ${APP_SCHEMA[entityKey].title}。`, { databaseName: name, dataSourceIds: { ...dataSourceIds }, stage: `reuse-data-source:${entityKey}` });
          await this.ensureDataSourceTitle(source, entityKey);
          continue;
        }
        await report(`恢复初始化：正在创建缺失的 ${APP_SCHEMA[entityKey].title}…`, { databaseName: name, dataSourceIds: { ...dataSourceIds }, stage: `create-data-source:${entityKey}` });
        const created = await this.createDataSource(databaseId, entityKey);
        this.assertDataSourceParent(created, databaseId);
        dataSourceIds[entityKey] = created.id;
        await report(`已恢复 ${APP_SCHEMA[entityKey].title}，恢复点已更新。`, { dataSourceIds: { ...dataSourceIds } });
      }
      for (const entityKey of DATA_SOURCE_KEYS) {
        await report(`恢复初始化：正在核对 ${APP_SCHEMA[entityKey].title} Relation…`, { dataSourceIds: { ...dataSourceIds }, stage: `ensure-relations:${entityKey}` });
        await this.updateRelations(entityKey, dataSourceIds);
      }
      await report("恢复初始化：正在验证最终 Schema…", { dataSourceIds: { ...dataSourceIds }, stage: "validate-schema" });
      const connection = await this.buildConnection(databaseId, dataSourceIds, partial.databaseUrl || database.url || null, name);
      await report("Schema 验证完成，等待提交本机 connection…", { dataSourceIds: { ...dataSourceIds }, stage: "schema-verified" });
      return connection;
    } catch (error) {
      error.initializationContext = { ...context, dataSourceIds: { ...(context.dataSourceIds || {}) } };
      throw error;
    }
  }

  dataSourceTitle(summary) {
    return typeof summary.name === "string" ? summary.name : typeof summary.title === "string" ? summary.title : plainTitle(summary.title) || plainTitle(summary.name);
  }

  async connectDatabase(databaseInput) {
    const databaseId = extractNotionId(databaseInput);
    const database = await this.retrieveDatabase(databaseId);
    const summaries = database.data_sources || [];
    const dataSourceIds = {};
    const missing = [];
    for (const entityKey of DATA_SOURCE_KEYS) {
      const expected = APP_SCHEMA[entityKey].title;
      const matches = summaries.filter(summary => this.dataSourceTitle(summary) === expected);
      if (matches.length !== 1) missing.push(`${expected}（找到 ${matches.length} 个）`);
      else dataSourceIds[entityKey] = matches[0].id;
    }
    if (missing.length) throw new NotionApiError(`不是符合当前 PWA 必需 Schema 的 Database：${missing.join("、")}`, { code: "schema_mismatch", details: missing });
    return this.buildConnection(databaseId, dataSourceIds, database.url || String(databaseInput), databaseTitle(database));
  }

  async buildConnection(databaseId, dataSourceIds, databaseUrl, databaseName = "未命名 Database") {
    const propertyIds = {};
    const mismatches = [];
    for (const entityKey of DATA_SOURCE_KEYS) {
      const source = await this.retrieveDataSource(dataSourceIds[entityKey]);
      propertyIds[entityKey] = {};
      for (const [semanticKey, expected] of Object.entries(APP_SCHEMA[entityKey].properties)) {
        const actual = Object.values(source.properties || {}).find(property => property.name === expected.name);
        if (!actual) mismatches.push(`${APP_SCHEMA[entityKey].title}.${expected.name} 缺失`);
        else if (actual.type !== expected.type) mismatches.push(`${APP_SCHEMA[entityKey].title}.${expected.name} 应为 ${expected.type}，实际为 ${actual.type}`);
        else {
          if (expected.target) {
            const actualTarget = String(actual.relation?.data_source_id || "").replace(/-/g, "").toLowerCase();
            const expectedTarget = String(dataSourceIds[expected.target] || "").replace(/-/g, "").toLowerCase();
            if (actualTarget !== expectedTarget) mismatches.push(`${APP_SCHEMA[entityKey].title}.${expected.name} Relation 目标不匹配`);
          }
          if (expected.type === "select") {
            const expectedOptions = (expected.schema.select.options || []).map(option => option.name);
            const actualOptions = (actual.select?.options || []).map(option => option.name);
            const missingOptions = expectedOptions.filter(name => !actualOptions.includes(name));
            if (missingOptions.length) mismatches.push(`${APP_SCHEMA[entityKey].title}.${expected.name} 缺少选项：${missingOptions.join("、")}`);
          }
          propertyIds[entityKey][semanticKey] = actual.id;
        }
      }
    }
    if (mismatches.length) throw new NotionApiError(`远程 Schema 不匹配，已停止连接：${mismatches.join("；")}`, { code: "schema_mismatch", details: mismatches });
    return {
      databaseId, databaseName: String(databaseName || "").trim() || "未命名 Database", databaseUrl, dataSourceIds, propertyIds,
      notionVersion: NOTION_VERSION, schemaVersion: SCHEMA_VERSION,
      connectedAt: new Date().toISOString()
    };
  }

  async queryAll(dataSourceId) {
    const results = [];
    let cursor = null;
    const seenCursors = new Set();
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const page = await this.request(`/data_sources/${dataSourceId}/query`, { method: "POST", body });
      if (page.request_status?.type === "incomplete") {
        throw new NotionApiError("Notion 返回不完整查询结果，已停止刷新，未将缺失记录视为删除。", { code: "incomplete_read", details: page.request_status });
      }
      results.push(...page.results.filter(result => result.object === "page"));
      if (page.has_more && !page.next_cursor) {
        throw new NotionApiError("Notion 分页响应缺少 next_cursor，已停止刷新，未将缺失记录视为删除。", { code: "incomplete_read" });
      }
      cursor = page.has_more ? page.next_cursor : null;
      if (cursor && seenCursors.has(cursor)) {
        throw new NotionApiError("Notion 返回了重复分页游标，已停止刷新，未更新本地正式数据。", { code: "incomplete_read" });
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return results;
  }

  createPage(dataSourceId, properties) {
    return this.request("/pages", {
      method: "POST",
      body: { parent: { type: "data_source_id", data_source_id: dataSourceId }, properties }
    });
  }

  updatePage(pageId, properties) {
    return this.request(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
  }

  async uploadFile(file) {
    const upload = await this.request("/file_uploads", {
      method: "POST",
      body: { mode: "single_part", filename: file.name, content_type: file.type || "application/octet-stream" }
    });
    const form = new FormData();
    form.append("file", file, file.name);
    await this.request(`/file_uploads/${upload.id}/send`, { method: "POST", rawBody: form });
    return upload.id;
  }
}

export const notionApi = new NotionApiAdapter();

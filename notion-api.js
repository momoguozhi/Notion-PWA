import { APP_SCHEMA, DATA_SOURCE_KEYS, NOTION_VERSION, baseProperties, relationProperties } from "./schema.js";
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
  const raw = String(input || "").trim();
  const dashedPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const exactCompact = raw.match(/^([0-9a-f]{32})$/i);
  const exactDashed = raw.match(new RegExp(`^${dashedPattern.source}$`, "i"));
  let id = exactCompact?.[1] || exactDashed?.[1]?.replace(/-/g, "");
  if (!id) {
    let lastSegment = raw;
    try {
      const url = new URL(raw);
      lastSegment = decodeURIComponent(url.pathname).split("/").filter(Boolean).at(-1) || "";
    } catch {
      lastSegment = decodeURIComponent(raw.split(/[?#]/)[0]).split("/").filter(Boolean).at(-1) || raw;
    }
    const dashed = lastSegment.match(dashedPattern);
    const compactAtEnd = lastSegment.match(/([0-9a-f]{32})$/i);
    id = dashed?.[1]?.replace(/-/g, "") || compactAtEnd?.[1];
  }
  if (!id) throw new Error("无法从输入内容识别 Notion ID。");
  id = id.toLowerCase();
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

function plainTitle(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => part.plain_text || part.text?.content || "").join("");
  return "";
}

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
    await this.request(`/data_sources/${dataSourceIds[entityKey]}`, {
      method: "PATCH", body: { properties }
    });
  }

  async initializeDatabase(parentPageInput, progress = () => {}) {
    const parentPageId = extractNotionId(parentPageInput);
    await progress("正在创建专属 Database 和大分类 Data Source…");
    const database = await this.request("/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: "NOTION PWA" } }],
        initial_data_source: { properties: baseProperties(DATA_SOURCE_KEYS[0]) }
      }
    });
    const databaseId = database.id;
    const dataSourceIds = {};
    const initial = database.data_sources?.[0];
    if (!initial?.id) throw new NotionApiError("Database 已创建，但响应中缺少初始 Data Source ID；可通过“连接已有数据库”恢复。", { code: "initialization_interrupted" });
    dataSourceIds[DATA_SOURCE_KEYS[0]] = initial.id;
    await progress("Database 已创建，正在保存恢复点…", { databaseId, dataSourceIds: { ...dataSourceIds }, databaseUrl: database.url || null });
    await this.request(`/data_sources/${initial.id}`, { method: "PATCH", body: { title: [{ type: "text", text: { content: APP_SCHEMA[DATA_SOURCE_KEYS[0]].title } }] } });
    await progress("正在创建小分类、状态、具体资料和配对记录 Data Source…");
    for (const entityKey of DATA_SOURCE_KEYS.slice(1)) {
      const dataSource = await this.createDataSource(databaseId, entityKey);
      dataSourceIds[entityKey] = dataSource.id;
      await progress(`已创建 ${APP_SCHEMA[entityKey].title}，正在保存恢复点…`, { databaseId, dataSourceIds: { ...dataSourceIds }, databaseUrl: database.url || null });
    }
    await progress("正在补建 Relation Property…");
    for (const entityKey of DATA_SOURCE_KEYS) await this.updateRelations(entityKey, dataSourceIds);
    await progress("正在重新读取并验证最终 Schema…");
    return this.buildConnection(databaseId, dataSourceIds, database.url || null);
  }

  async resumeInitialization(partial, progress = () => {}) {
    const databaseId = extractNotionId(partial.databaseId);
    const database = await this.retrieveDatabase(databaseId);
    const summaries = database.data_sources || [];
    const dataSourceIds = { ...(partial.dataSourceIds || {}) };
    for (const entityKey of DATA_SOURCE_KEYS) {
      if (dataSourceIds[entityKey]) {
        try { await this.retrieveDataSource(dataSourceIds[entityKey]); continue; }
        catch (error) { if (error.status !== 404) throw error; delete dataSourceIds[entityKey]; }
      }
      const matches = summaries.filter(summary => this.dataSourceTitle(summary) === APP_SCHEMA[entityKey].title);
      if (matches.length > 1) {
        throw new NotionApiError(`恢复初始化时发现多个“${APP_SCHEMA[entityKey].title}”Data Source，已停止以避免错连。`, { code: "schema_mismatch" });
      }
      if (matches.length === 1) {
        dataSourceIds[entityKey] = matches[0].id;
        await progress(`恢复初始化：已找到现有 ${APP_SCHEMA[entityKey].title}，未重复创建。`, { databaseId, dataSourceIds: { ...dataSourceIds }, databaseUrl: partial.databaseUrl || database.url || null });
        continue;
      }
      await progress(`恢复初始化：正在创建缺失的 ${APP_SCHEMA[entityKey].title}…`);
      const created = await this.createDataSource(databaseId, entityKey);
      dataSourceIds[entityKey] = created.id;
      await progress(`已恢复 ${APP_SCHEMA[entityKey].title}，正在保存恢复点…`, { databaseId, dataSourceIds: { ...dataSourceIds }, databaseUrl: partial.databaseUrl || null });
    }
    for (const entityKey of DATA_SOURCE_KEYS) await this.updateRelations(entityKey, dataSourceIds);
    return this.buildConnection(databaseId, dataSourceIds, partial.databaseUrl || null);
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
    if (missing.length) throw new NotionApiError(`不是符合 v0.4 的 PWA Database：${missing.join("、")}`, { code: "schema_mismatch", details: missing });
    return this.buildConnection(databaseId, dataSourceIds, database.url || String(databaseInput));
  }

  async buildConnection(databaseId, dataSourceIds, databaseUrl) {
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
      databaseId, databaseUrl, dataSourceIds, propertyIds,
      notionVersion: NOTION_VERSION, schemaVersion: 4,
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

  archivePage(pageId) {
    return this.request(`/pages/${pageId}`, { method: "PATCH", body: { archived: true } });
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

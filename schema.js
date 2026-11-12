export const NOTION_VERSION = "2026-03-11";
// Remote business schema version. This is independent from the app and IndexedDB versions.
export const SCHEMA_VERSION = 5;

export const ENTITY = Object.freeze({
  MAJOR: "majorCategories",
  SUB: "subCategories",
  ITEM: "items",
  PAIRING: "pairings"
});

export const DATA_SOURCE_KEYS = [ENTITY.MAJOR, ENTITY.SUB, ENTITY.ITEM, ENTITY.PAIRING];

export const APP_SCHEMA = Object.freeze({
  [ENTITY.MAJOR]: {
    title: "大分类",
    properties: {
      name: { name: "名称", type: "title", schema: { title: {} } },
      sort: { name: "排序", type: "number", schema: { number: { format: "number" } } }
    }
  },
  [ENTITY.SUB]: {
    title: "小分类",
    properties: {
      name: { name: "名称", type: "title", schema: { title: {} } },
      major: { name: "所属大分类", type: "relation", target: ENTITY.MAJOR },
      sort: { name: "排序", type: "number", schema: { number: { format: "number" } } }
    }
  },
  [ENTITY.ITEM]: {
    title: "具体资料",
    properties: {
      name: { name: "名称", type: "title", schema: { title: {} } },
      uniqueId: { name: "个体编号", type: "unique_id", schema: { unique_id: { prefix: "ITEM" } }, readonly: true },
      acquisitionDate: { name: "入手日期", type: "date", schema: { date: {} } },
      source: { name: "来源", type: "rich_text", schema: { rich_text: {} } },
      sub: { name: "小分类", type: "relation", target: ENTITY.SUB },
      price: { name: "价格", type: "number", schema: { number: { format: "number" } } },
      currency: { name: "货币", type: "select", schema: { select: { options: ["JPY", "CNY", "USD"].map(name => ({ name })) } } },
      quantity: { name: "数量", type: "number", schema: { number: { format: "number" } } },
      photos: { name: "照片", type: "files", schema: { files: {} } }
    }
  },
  [ENTITY.PAIRING]: {
    title: "配对记录",
    properties: {
      name: { name: "记录名称", type: "title", schema: { title: {} } },
      mother: { name: "母本", type: "relation", target: ENTITY.ITEM },
      father: { name: "父本", type: "relation", target: ENTITY.ITEM },
      pollinationDate: { name: "授粉日期", type: "date", schema: { date: {} } },
      harvestDate: { name: "结种／收种日期", type: "date", schema: { date: {} } },
      children: { name: "子代", type: "relation", target: ENTITY.ITEM }
    }
  }
});

export const ITEM_DISPLAY_FIELDS = Object.freeze([
  { key: "name", label: "名称" },
  { key: "category", label: "分类" },
  { key: "price", label: "价格" },
  { key: "quantity", label: "数量" },
  { key: "acquisitionDate", label: "入手日期" },
  { key: "source", label: "来源" }
]);

export const DEFAULT_DISPLAY_PREFERENCES = Object.freeze({
  mobileColumns: 4,
  desktopColumns: 5,
  desktopView: "table",
  fields: ["name", "category"],
  fieldOrder: ITEM_DISPLAY_FIELDS.map(field => field.key)
});

export function relationSchema(targetDataSourceId) {
  return { relation: { data_source_id: targetDataSourceId, type: "single_property", single_property: {} } };
}

export function baseProperties(entityKey) {
  const result = {};
  Object.values(APP_SCHEMA[entityKey].properties).forEach(property => {
    if (!property.target) result[property.name] = property.schema;
  });
  return result;
}

export function relationProperties(entityKey, dataSourceIds) {
  const result = {};
  Object.values(APP_SCHEMA[entityKey].properties).forEach(property => {
    if (property.target) result[property.name] = relationSchema(dataSourceIds[property.target]);
  });
  return result;
}

export function createLocalRecord(entity, values = {}) {
  const now = new Date().toISOString();
  return {
    localId: crypto.randomUUID(),
    notionPageId: null,
    notionUniqueId: null,
    dirty: true,
    pending: true,
    lastRemoteEdit: null,
    syncBase: null,
    uploadError: null,
    createdAt: now,
    updatedAt: now,
    entity,
    ...values
  };
}

export function stripDeprecatedItemFields(record) {
  const cleaned = { ...record };
  ["status", "entryType", "directSource", "directSourceLocalId", "directSourcePageId", "cuttingDate"].forEach(key => delete cleaned[key]);
  return cleaned;
}

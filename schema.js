export const NOTION_VERSION = "2026-03-11";
export const SCHEMA_VERSION = 3;

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
      status: { name: "状态", type: "select", schema: { select: { options: ["在库", "培育中", "已售出", "已枯失", "其他"].map(name => ({ name })) } } },
      entryType: { name: "录入类型", type: "select", schema: { select: { options: ["播种苗", "成品"].map(name => ({ name })) } } },
      photos: { name: "照片", type: "files", schema: { files: {} } },
      directSource: { name: "直接来源", type: "relation", target: ENTITY.ITEM },
      cuttingDate: { name: "扦插日期", type: "date", schema: { date: {} } }
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
  { key: "notionUniqueId", label: "编号" },
  { key: "category", label: "分类" },
  { key: "price", label: "价格" },
  { key: "status", label: "状态" },
  { key: "quantity", label: "数量" },
  { key: "entryType", label: "录入类型" },
  { key: "acquisitionDate", label: "入手日期" },
  { key: "source", label: "来源" }
]);

export const DEFAULT_DISPLAY_PREFERENCES = Object.freeze({
  mobileColumns: 4,
  desktopColumns: 5,
  desktopView: "table",
  fields: ["name", "notionUniqueId", "status"],
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

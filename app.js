"use strict";

const purchaseSchema = [
  { key: "name", label: "商品名称", type: "text", group: "常用字段", required: true },
  { key: "category", label: "商品类别", type: "select", options: ["文具", "家居", "数码", "服饰", "食品"], group: "常用字段" },
  { key: "code", label: "商品编码", type: "text", group: "常用字段" },
  { key: "quantity", label: "数量", type: "number", min: 0, group: "常用字段" },
  { key: "unitPrice", label: "采购单价", type: "number", step: "0.01", min: 0, group: "价格与日期" },
  { key: "currency", label: "币种", type: "select", options: ["JPY", "CNY", "USD", "EUR"], group: "价格与日期" },
  { key: "exchangeRate", label: "汇率（兑日元）", type: "number", step: "0.0001", min: 0, group: "价格与日期" },
  { key: "discount", label: "折扣（%）", type: "number", step: "1", min: 0, max: 100, group: "价格与日期" },
  { key: "purchaseDate", label: "采购日期", type: "date", group: "价格与日期" },
  { key: "store", label: "店铺", type: "text", group: "来源资料" },
  { key: "url", label: "商品网址", type: "url", group: "来源资料" },
  { key: "image", label: "图片地址", type: "url", group: "来源资料" },
  { key: "status", label: "状态", type: "select", options: ["待采购", "已采购", "已入库", "部分售出", "已售罄"], group: "常用字段" },
  { key: "notes", label: "备注", type: "textarea", group: "来源资料", full: true },
  { key: "totalCost", label: "采购总额（日元）", type: "formula", group: "计算与关联" },
  { key: "saleIds", label: "关联售出记录", type: "relation", target: "sales", group: "计算与关联", full: true }
];

const saleSchema = [
  { key: "customer", label: "顾客", type: "text", group: "售出信息", required: true },
  { key: "purchaseIds", label: "关联商品", type: "relation", target: "purchases", group: "售出信息", full: true },
  { key: "quantity", label: "数量", type: "number", min: 0, group: "售出信息" },
  { key: "salePrice", label: "售价（日元）", type: "number", step: "1", min: 0, group: "价格与日期" },
  { key: "shipping", label: "运费（日元）", type: "number", step: "1", min: 0, group: "价格与日期" },
  { key: "saleDate", label: "出售日期", type: "date", group: "价格与日期" },
  { key: "netIncome", label: "净收入（日元）", type: "formula", group: "价格与日期" }
];

const initialData = {
  purchases: [
    { id:"p1", name:"黄铜自动铅笔", category:"文具", code:"ST-104", quantity:4, unitPrice:120, currency:"CNY", exchangeRate:20.6, discount:10, purchaseDate:"2026-09-18", store:"拾光文具", url:"https://example.com/pencil", image:"https://example.com/image/pencil.jpg", status:"部分售出", notes:"虚构样品：雾面黄铜笔身", saleIds:["s1","s3"] },
    { id:"p2", name:"折叠桌面灯", category:"家居", code:"HM-208", quantity:2, unitPrice:4200, currency:"JPY", exchangeRate:1, discount:0, purchaseDate:"2026-09-24", store:"北町生活馆", url:"https://example.com/lamp", image:"https://example.com/image/lamp.jpg", status:"已入库", notes:"虚构样品：暖白光三档", saleIds:[] },
    { id:"p3", name:"复古蓝牙音箱", category:"数码", code:"DG-077", quantity:3, unitPrice:38, currency:"USD", exchangeRate:148.2, discount:5, purchaseDate:"2026-10-02", store:"Cloud Audio", url:"https://example.com/speaker", image:"https://example.com/image/speaker.jpg", status:"部分售出", notes:"虚构样品：蓝灰配色", saleIds:["s2"] },
    { id:"p4", name:"亚麻收纳袋", category:"家居", code:"HM-311", quantity:8, unitPrice:36, currency:"CNY", exchangeRate:20.6, discount:0, purchaseDate:"2026-10-11", store:"木棉杂货", url:"https://example.com/bag", image:"https://example.com/image/bag.jpg", status:"待采购", notes:"虚构样品：三种尺寸", saleIds:[] }
  ],
  sales: [
    { id:"s1", customer:"佐藤葵（示例）", purchaseIds:["p1"], quantity:1, salePrice:4200, shipping:210, saleDate:"2026-10-08" },
    { id:"s2", customer:"林晓（示例）", purchaseIds:["p3"], quantity:1, salePrice:9200, shipping:520, saleDate:"2026-10-14" },
    { id:"s3", customer:"田中悠（示例）", purchaseIds:["p1","p3"], quantity:2, salePrice:7600, shipping:350, saleDate:"2026-10-19" }
  ]
};

const databaseMeta = {
  purchases: { title:"采购清单", schema:purchaseSchema, relationKey:"saleIds", target:"sales", primary:"name", subtitle:"16 个字段 · 商品、来源、价格、公式与售出关联" },
  sales: { title:"售出记录", schema:saleSchema, relationKey:"purchaseIds", target:"purchases", primary:"customer", subtitle:"7 个字段 · 顾客、商品、售价与净收入" }
};

let data = structuredClone(initialData);
let state = { db:"purchases", query:"", filter:"all", selected:null, editing:null, history:[], creating:null };
let idCounter = 100;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function getSchema(db = state.db) { return databaseMeta[db].schema; }
function getRecord(db, id) { return data[db].find(record => record.id === id); }
function formula(db, record, key) {
  if (db === "purchases" && key === "totalCost") return Math.round((+record.quantity || 0) * (+record.unitPrice || 0) * (+record.exchangeRate || 0) * (1 - (+record.discount || 0) / 100));
  if (db === "sales" && key === "netIncome") return (+record.salePrice || 0) - (+record.shipping || 0);
  return "";
}
function displayValue(db, record, field) {
  if (!record) return "";
  if (field.type === "formula") return formula(db, record, field.key).toLocaleString("zh-CN");
  if (field.type === "relation") return (record[field.key] || []).map(id => getRecord(field.target, id)?.[databaseMeta[field.target].primary] || "已删除记录").join("、");
  if (field.key === "unitPrice" || field.key === "salePrice" || field.key === "shipping") return (+record[field.key] || 0).toLocaleString("zh-CN");
  return record[field.key] ?? "";
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char])); }
function toast(message) { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove("show"),1800); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); toast("已复制到剪贴板"); }
  catch { const area=document.createElement("textarea"); area.value=String(text); document.body.append(area); area.select(); document.execCommand("copy"); area.remove(); toast("已复制到剪贴板"); }
}

function filteredRecords() {
  const meta=databaseMeta[state.db];
  return data[state.db].filter(record => {
    const haystack=getSchema().map(field=>displayValue(state.db,record,field)).join(" ").toLowerCase();
    const searchOk=haystack.includes(state.query.toLowerCase());
    let filterOk=true;
    if (state.filter==="linked") filterOk=(record[meta.relationKey]||[]).length>0;
    if (state.filter==="unlinked") filterOk=(record[meta.relationKey]||[]).length===0;
    if (state.filter.startsWith("value:")) { const [,key,value]=state.filter.split(":"); filterOk=String(record[key])===value; }
    return searchOk && filterOk;
  });
}

function visibleColumns(db=state.db) {
  const keys=db==="purchases" ? ["name","category","code","quantity","unitPrice","purchaseDate","status","totalCost","saleIds"] : ["customer","purchaseIds","quantity","salePrice","shipping","saleDate","netIncome"];
  return keys.map(key=>databaseMeta[db].schema.find(field=>field.key===key));
}

function render() {
  const meta=databaseMeta[state.db], records=filteredRecords();
  $$(".tab").forEach(tab=>tab.classList.toggle("active",tab.dataset.db===state.db));
  $("#purchase-count").textContent=data.purchases.length; $("#sale-count").textContent=data.sales.length;
  $("#view-title").textContent=meta.title; $("#view-subtitle").textContent=meta.subtitle;
  renderFilter(); renderTable(records); renderCards(records);
  $("#empty-state").hidden=records.length>0;
}

function renderFilter() {
  const select=$("#filter"), previous=state.filter;
  const options=[['all','全部记录'],['linked','已有跨表关联'],['unlinked','尚未关联']];
  if(state.db==="purchases") options.push(...["待采购","已采购","已入库","部分售出","已售罄"].map(v=>[`value:status:${v}`,v]));
  select.innerHTML=options.map(([value,label])=>`<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
  select.value=[...select.options].some(o=>o.value===previous)?previous:"all"; state.filter=select.value;
}

function renderTable(records) {
  const columns=visibleColumns();
  $("#desktop-table").innerHTML=`<table><thead><tr>${columns.map(f=>`<th>${escapeHtml(f.label)}</th>`).join("")}<th class="row-actions">操作</th></tr></thead><tbody>${records.map(record=>`<tr data-id="${record.id}">${columns.map(field=>{
    if(field.type==="relation") return `<td data-key="${field.key}">${relationButtons(record,field)}</td>`;
    const value=displayValue(state.db,record,field); return `<td data-key="${field.key}" title="${escapeHtml(value)}" class="${field.key===databaseMeta[state.db].primary?'name-cell ':''}${field.type==='number'||field.type==='formula'?'money':''}">${escapeHtml(value)||'<span class="muted">—</span>'}</td>`;
  }).join("")}<td class="row-actions"><button data-edit="${record.id}">编辑</button></td></tr>`).join("")}</tbody></table>`;
}
function relationButtons(record,field) {
  const ids=record[field.key]||[];
  if(!ids.length) return '<span class="muted">未关联</span>';
  return ids.map(id=>`<button class="relation-chip" data-jump-db="${field.target}" data-jump-id="${id}">${escapeHtml(getRecord(field.target,id)?.[databaseMeta[field.target].primary]||"已删除")}</button>`).join("");
}
function renderCards(records) {
  const meta=databaseMeta[state.db], fields=visibleColumns().filter(f=>f.type!=="relation").slice(1,5), relation=getSchema().find(f=>f.type==="relation");
  $("#mobile-cards").innerHTML=records.map(record=>`<article class="record-card" data-id="${record.id}"><div class="card-top"><h3>${escapeHtml(record[meta.primary]||"未命名")}</h3><button data-edit="${record.id}">编辑</button></div><div class="card-meta">${fields.map(f=>`<div><small>${escapeHtml(f.label)}</small><span>${escapeHtml(displayValue(state.db,record,f))||"—"}</span></div>`).join("")}</div><div class="card-relations"><small class="muted">${escapeHtml(relation.label)}</small><div>${relationButtons(record,relation)}</div></div></article>`).join("");
}

function blankRecord(db) {
  const record={id:(db==="purchases"?"p":"s")+(++idCounter)};
  getSchema(db).forEach(field=>{ if(field.type==="relation") record[field.key]=[]; else if(field.type==="number") record[field.key]=0; else if(field.type!=="formula") record[field.key]=field.options?.[0]||""; });
  if(db==="purchases") { record.currency="JPY"; record.exchangeRate=1; record.discount=0; record.status="待采购"; }
  return record;
}

function openRecord(db,id,{pushHistory=false}={}) {
  if(pushHistory && state.editing) state.history.push({...state.editing});
  state.editing={db,id};
  const record=getRecord(db,id), meta=databaseMeta[db]; if(!record) return;
  $("#dialog-db").textContent=meta.title; $("#dialog-title").textContent=record[meta.primary]||"新记录";
  $("#back-record").hidden=state.history.length===0;
  const groups=[...new Set(meta.schema.map(field=>field.group))];
  $("#form-fields").innerHTML=groups.map((group,index)=>`<details class="field-group" ${index<2?'open':''}><summary>${escapeHtml(group)}</summary><div class="field-grid">${meta.schema.filter(field=>field.group===group).map(field=>fieldControl(db,record,field)).join("")}</div></details>`).join("");
  const dialog=$("#record-dialog"); if(!dialog.open) dialog.showModal();
}
function fieldControl(db,record,field) {
  const value=record[field.key]??"", copy=`<button type="button" data-copy-field="${field.key}">复制</button>`;
  let control="";
  if(field.type==="formula") control=`<output>${escapeHtml(displayValue(db,record,field))}</output>`;
  else if(field.type==="select") control=`<select name="${field.key}">${field.options.map(option=>`<option ${value===option?'selected':''}>${escapeHtml(option)}</option>`).join("")}</select>`;
  else if(field.type==="textarea") control=`<textarea name="${field.key}" rows="3">${escapeHtml(value)}</textarea>`;
  else if(field.type==="relation") control=`<div class="relation-options">${data[field.target].map(target=>`<label><input type="checkbox" name="${field.key}" value="${target.id}" ${(value||[]).includes(target.id)?'checked':''}> <span>${escapeHtml(target[databaseMeta[field.target].primary])}</span></label>`).join("")||'<span class="muted">目标数据库暂无记录</span>'}</div>`;
  else control=`<input name="${field.key}" type="${field.type}" value="${escapeHtml(value)}" ${field.required?'required':''} ${field.min!==undefined?`min="${field.min}"`:''} ${field.max!==undefined?`max="${field.max}"`:''} ${field.step?`step="${field.step}"`:''}>`;
  return `<label class="field ${field.full?'full':''}"><span class="field-label"><span>${escapeHtml(field.label)}</span>${copy}</span>${control}</label>`;
}

function readForm(db,base) {
  const form=$("#record-form"), result={...base};
  getSchema(db).forEach(field=>{
    if(field.type==="formula") return;
    if(field.type==="relation") result[field.key]=[...form.querySelectorAll(`[name="${field.key}"]:checked`)].map(input=>input.value);
    else { const input=form.elements[field.key]; result[field.key]=field.type==="number" ? Number(input.value||0) : input.value.trim(); }
  });
  return result;
}
function syncRelations(db,id,newIds) {
  const meta=databaseMeta[db], reverse=databaseMeta[meta.target].relationKey;
  data[meta.target].forEach(target=>{ target[reverse]=(target[reverse]||[]).filter(linked=>linked!==id); });
  newIds.forEach(targetId=>{ const target=getRecord(meta.target,targetId); if(target&&!target[reverse].includes(id)) target[reverse].push(id); });
}
function saveEditing() {
  const {db,id}=state.editing, index=data[db].findIndex(record=>record.id===id); if(index<0) return;
  const updated=readForm(db,data[db][index]); data[db][index]=updated;
  syncRelations(db,id,updated[databaseMeta[db].relationKey]||[]); state.creating=null; render(); closeRecord(); toast("修改已保存于本次会话");
}
function closeRecord() {
  if(state.creating && state.editing?.id===state.creating.id) {
    data[state.creating.db]=data[state.creating.db].filter(record=>record.id!==state.creating.id);
    state.creating=null; render();
  }
  $("#record-dialog").close(); state.editing=null; state.history=[];
}
function deleteEditing() {
  const {db,id}=state.editing, record=getRecord(db,id); if(!record||!confirm(`删除“${record[databaseMeta[db].primary]}”？关联记录会同步解除。`)) return;
  syncRelations(db,id,[]); data[db]=data[db].filter(item=>item.id!==id); closeRecord(); render(); toast("记录已删除（刷新可恢复）");
}
function recordAsText(db,record) { return getSchema(db).map(field=>`${field.label}: ${displayValue(db,record,field)}`).join("\n"); }

function parseCell(field,value) {
  if(field.type==="number") { const normalized=String(value).replace(/[,，￥¥$€%\s]/g,""); const parsed=Number(normalized); return Number.isFinite(parsed)?parsed:0; }
  if(field.type==="select") return field.options.includes(value)?value:(value||field.options[0]);
  return value;
}
function openPaste() {
  const columns=visibleColumns().filter(field=>field.type!=="relation"&&field.type!=="formula");
  const startIndex=state.selected ? Math.max(0,columns.findIndex(f=>f.key===state.selected.key)) : 0;
  $("#paste-help").textContent=`从“${columns[startIndex].label}”列开始，依次对应：${columns.slice(startIndex).map(f=>f.label).join(" → ")}。超出现有记录的行会新增。公式和关联字段请在编辑窗口维护。`;
  $("#paste-input").value=""; $("#paste-preview").textContent=""; $("#paste-dialog").showModal(); setTimeout(()=>$("#paste-input").focus(),50);
}
function applyPaste() {
  const rows=$("#paste-input").value.replace(/\r/g,"").split("\n").filter(line=>line.length).map(line=>line.split("\t"));
  if(!rows.length) return toast("没有可应用的数据");
  const columns=visibleColumns().filter(field=>field.type!=="relation"&&field.type!=="formula");
  const startCol=state.selected?Math.max(0,columns.findIndex(f=>f.key===state.selected.key)):0;
  const startRow=state.selected?Math.max(0,data[state.db].findIndex(r=>r.id===state.selected.id)):data[state.db].length;
  rows.forEach((cells,rowOffset)=>{
    let record=data[state.db][startRow+rowOffset]; if(!record){record=blankRecord(state.db); data[state.db].push(record);}
    cells.forEach((value,colOffset)=>{ const field=columns[startCol+colOffset]; if(field) record[field.key]=parseCell(field,value.trim()); });
  });
  $("#paste-dialog").close(); render(); toast(`已应用 ${rows.length} 行数据`);
}

document.addEventListener("click",event=>{
  const tab=event.target.closest(".tab"); if(tab){ state.db=tab.dataset.db; state.query=""; state.filter="all"; state.selected=null; $("#search").value=""; render(); return; }
  const edit=event.target.closest("[data-edit]"); if(edit){ openRecord(state.db,edit.dataset.edit); return; }
  const jump=event.target.closest("[data-jump-id]"); if(jump){ openRecord(jump.dataset.jumpDb,jump.dataset.jumpId,{pushHistory:true}); return; }
  const cell=event.target.closest("td[data-key]"); if(cell&&!event.target.closest("button")){ $$("td.selected").forEach(td=>td.classList.remove("selected")); cell.classList.add("selected"); state.selected={id:cell.closest("tr").dataset.id,key:cell.dataset.key}; }
  const copy=event.target.closest("[data-copy-field]"); if(copy&&state.editing){ const record=getRecord(state.editing.db,state.editing.id),field=getSchema(state.editing.db).find(f=>f.key===copy.dataset.copyField); copyText(displayValue(state.editing.db,record,field)); }
});
$("#search").addEventListener("input",event=>{state.query=event.target.value;render();});
$("#filter").addEventListener("change",event=>{state.filter=event.target.value;render();});
$("#add-record").addEventListener("click",()=>{const record=blankRecord(state.db);data[state.db].push(record);state.creating={db:state.db,id:record.id};render();openRecord(state.db,record.id);});
$("#reset-data").addEventListener("click",()=>{if(confirm("恢复全部初始模拟数据？当前会话中的修改将丢失。")){data=structuredClone(initialData);state.selected=null;render();toast("已恢复初始数据");}});
$("#record-form").addEventListener("submit",event=>{event.preventDefault();saveEditing();});
$$(".close-dialog").forEach(button=>button.addEventListener("click",closeRecord));
$("#delete-record").addEventListener("click",deleteEditing);
$("#copy-record").addEventListener("click",()=>{if(state.editing)copyText(recordAsText(state.editing.db,getRecord(state.editing.db,state.editing.id)));});
$("#back-record").addEventListener("click",()=>{const previous=state.history.pop();if(previous)openRecord(previous.db,previous.id);});
$("#paste-grid").addEventListener("click",openPaste);
$$(".close-paste").forEach(button=>button.addEventListener("click",()=>$("#paste-dialog").close()));
$("#paste-form").addEventListener("submit",event=>{event.preventDefault();applyPaste();});
$("#paste-input").addEventListener("input",event=>{const rows=event.target.value.replace(/\r/g,"").split("\n").filter(Boolean);$("#paste-preview").textContent=rows.length?`检测到 ${rows.length} 行，最多 ${Math.max(...rows.map(row=>row.split("\t").length))} 列。`:"";});
$("#desktop-table").addEventListener("keydown",event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="c"&&state.selected){const record=getRecord(state.db,state.selected.id),field=getSchema().find(f=>f.key===state.selected.key);copyText(displayValue(state.db,record,field));event.preventDefault();}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="v"){openPaste();event.preventDefault();}});
$("#record-dialog").addEventListener("cancel",event=>{event.preventDefault();closeRecord();});

if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(error=>console.warn("Service Worker 注册失败",error)));
render();

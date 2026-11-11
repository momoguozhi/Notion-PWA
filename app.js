import { APP_SCHEMA, DEFAULT_DISPLAY_PREFERENCES, ENTITY, ITEM_DISPLAY_FIELDS, createLocalRecord } from "./schema.js";
import { localDb } from "./storage.js";
import { credentials } from "./credentials.js";
import { notionApi, NotionApiError } from "./notion-api.js";
import { syncCoordinator, wouldCreateSourceCycle } from "./sync.js";
import { qrSvg } from "./qr.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const photoUrls = new Map();

const state = {
  connection: null,
  workspace: { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] },
  entity: ENTITY.ITEM,
  selectedMajorId: null,
  selectedSubId: null,
  query: "",
  editingId: null,
  photoDraft: [],
  refreshDraft: null,
  pendingCredentialAction: null,
  connectionSessionId: crypto.randomUUID(),
  connectionBusy: false,
  preferences: loadPreferences()
};

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("notion-pwa-v041-display") || "{}");
    return { ...structuredClone(DEFAULT_DISPLAY_PREFERENCES), ...saved };
  } catch { return structuredClone(DEFAULT_DISPLAY_PREFERENCES); }
}

function savePreferences() { localStorage.setItem("notion-pwa-v041-display", JSON.stringify(state.preferences)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '\"':"&quot;" }[char])); }
function toast(message, delay = 2400) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), delay); }
function recordName(record) { return record?.name || "（未命名）"; }
function entityList(entity = state.entity) { return state.workspace[entity] || []; }
function byId(entity, id) { return state.workspace[entity].find(record => record.localId === id) || null; }
function majorForSub(subId) { const sub = byId(ENTITY.SUB, subId); return sub ? byId(ENTITY.MAJOR, sub.majorLocalId) : null; }
function categoryLabel(item) { const sub = byId(ENTITY.SUB, item.subLocalId); const major = sub ? byId(ENTITY.MAJOR, sub.majorLocalId) : null; return [major?.name, sub?.name].filter(Boolean).join(" › "); }
function formatPrice(item) { return item.price == null || item.price === "" ? "" : `${Number(item.price).toLocaleString("zh-CN")} ${item.currency || ""}`.trim(); }
function notionLink(item) { return item.notionPageUrl || ""; }

function photoUrl(photo) {
  if (!photo) return "";
  if (photo.blob) {
    if (!photoUrls.has(photo.localId)) photoUrls.set(photo.localId, URL.createObjectURL(photo.blob));
    return photoUrls.get(photo.localId);
  }
  return photo.remoteUrl || photo.externalUrl || "";
}

function itemPhotos(item) {
  return (item.photoIds || []).map(id => state.workspace.photos.find(photo => photo.localId === id)).filter(Boolean).sort((a,b) => a.order - b.order);
}

function displayValue(item, key) {
  if (key === "category") return categoryLabel(item);
  if (key === "price") return formatPrice(item);
  if (key === "notionUniqueId") return item.notionUniqueId || "本地待编号";
  return item[key] ?? "";
}

function setBanner(kind, message) {
  const banner = $("#connection-banner");
  banner.classList.toggle("warning", kind === "warning");
  banner.classList.toggle("error", kind === "error");
  $("#connection-label").textContent = state.connection ? "已配置 PWA Database" : "本设备未连接";
  $("#sync-state").textContent = message;
}

async function reloadWorkspace() {
  state.workspace = await localDb.loadWorkspace(state.connection?.databaseId || null);
  normalizeSelection();
  render();
}

function captureSession() {
  const workspaceId = state.connection?.databaseId, sessionId = state.connectionSessionId;
  if (!workspaceId) throw new Error("当前没有 active Database。");
  return {
    workspaceId, sessionId,
    assertCurrent() {
      if (state.connection?.databaseId !== workspaceId || state.connectionSessionId !== sessionId) {
        throw new Error("连接会话已切换，旧异步操作结果已丢弃。");
      }
    }
  };
}

function resetWorkspaceUi() {
  state.workspace = { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
  state.selectedMajorId = null; state.selectedSubId = null; state.query = ""; state.editingId = null;
  state.photoDraft = []; state.refreshDraft = null; state.pendingCredentialAction = null;
  $("#search").value = "";
  ["#record-dialog", "#category-dialog", "#refresh-dialog"].forEach(selector => { const dialog = $(selector); if (dialog.open) dialog.close(); });
}

async function confirmWorkspaceRemoval(actionLabel) {
  if (!state.connection || !(await localDb.hasPending(state.connection.databaseId))) return true;
  return confirm(`${actionLabel}会删除当前 Database 的本地 Workspace，其中包含尚未上传的修改。\n\n确定继续并丢失这些本地内容吗？`);
}

async function commitConnectionSwitch(connection) {
  const oldWorkspaceId = state.connection?.databaseId || null;
  await localDb.commitConnectionSwitch(oldWorkspaceId, connection);
  state.connection = connection || null;
  state.connectionSessionId = crypto.randomUUID();
  localDb.setWorkspace(connection?.databaseId || null);
  resetWorkspaceUi();
  await reloadWorkspace();
}

function normalizeSelection() {
  const majors = [...state.workspace.majorCategories].sort((a,b) => a.sort-b.sort);
  if (!majors.some(record => record.localId === state.selectedMajorId)) state.selectedMajorId = majors[0]?.localId || null;
  const subs = state.workspace.subCategories.filter(record => record.majorLocalId === state.selectedMajorId).sort((a,b) => a.sort-b.sort);
  if (!subs.some(record => record.localId === state.selectedSubId)) state.selectedSubId = subs[0]?.localId || null;
}

function filteredRecords() {
  const query = state.query.toLocaleLowerCase("zh-CN");
  return entityList().filter(record => {
    if (state.entity === ENTITY.ITEM) {
      if (state.selectedSubId && record.subLocalId !== state.selectedSubId) return false;
      if (!state.selectedSubId && state.selectedMajorId && majorForSub(record.subLocalId)?.localId !== state.selectedMajorId) return false;
      const text = [record.name, record.notionUniqueId, categoryLabel(record), record.source, record.status, record.entryType].join(" ").toLocaleLowerCase("zh-CN");
      return text.includes(query);
    }
    const mother = byId(ENTITY.ITEM, record.motherLocalId), father = byId(ENTITY.ITEM, record.fatherLocalId);
    return [record.name, mother?.name, father?.name, record.pollinationDate].join(" ").toLocaleLowerCase("zh-CN").includes(query);
  });
}

function render() {
  normalizeSelection();
  $$(".entity-tab").forEach(button => button.classList.toggle("active", button.dataset.entity === state.entity));
  $("#item-count").textContent = state.workspace.items.length;
  $("#pairing-count").textContent = state.workspace.pairings.length;
  $("#view-title").textContent = APP_SCHEMA[state.entity].title;
  $("#category-browser").hidden = state.entity !== ENTITY.ITEM;
  $("#desktop-category-controls").hidden = state.entity !== ENTITY.ITEM;
  renderCategories(); renderPending(); renderViews();
}

function renderCategories() {
  if (state.entity !== ENTITY.ITEM) return;
  const majors = [...state.workspace.majorCategories].sort((a,b) => a.sort-b.sort);
  $("#major-categories").innerHTML = majors.map(record => `<button data-major="${record.localId}" class="${record.localId===state.selectedMajorId?'active':''}">${escapeHtml(recordName(record))}</button>`).join("") || '<span class="muted">请新增大分类</span>';
  const subs = state.workspace.subCategories.filter(record => record.majorLocalId === state.selectedMajorId).sort((a,b) => a.sort-b.sort);
  $("#sub-categories").innerHTML = subs.map(record => `<button data-sub="${record.localId}" class="${record.localId===state.selectedSubId?'active':''}">${escapeHtml(recordName(record))}</button>`).join("") || '<span class="muted">请新增小分类</span>';
  $("#desktop-major").innerHTML = majors.map(record => `<option value="${record.localId}" ${record.localId===state.selectedMajorId?'selected':''}>${escapeHtml(recordName(record))}</option>`).join("") || '<option value="">无大分类</option>';
  $("#desktop-sub").innerHTML = subs.map(record => `<option value="${record.localId}" ${record.localId===state.selectedSubId?'selected':''}>${escapeHtml(recordName(record))}</option>`).join("") || '<option value="">无小分类</option>';
  $("#desktop-category-controls").hidden = state.entity !== ENTITY.ITEM;
}

function renderPending() {
  const records = [...state.workspace.majorCategories, ...state.workspace.subCategories, ...state.workspace.items, ...state.workspace.pairings];
  const pending = records.filter(record => record.pending).length;
  const errors = records.filter(record => record.uploadError).length;
  $("#pending-summary").textContent = pending ? `${pending} 条待上传${errors ? ` · ${errors} 条失败` : ""}` : "无待上传变化";
}

function itemCard(item, compact = false) {
  const photo = itemPhotos(item)[0];
  const visible = state.preferences.fieldOrder.filter(key => state.preferences.fields.includes(key));
  return `<button class="data-card" data-open-record="${item.localId}"><span class="data-card-image">${photo?`<img src="${escapeHtml(photoUrl(photo))}" alt="">`:'◇'}</span><span class="data-card-body">${visible.map((key,index) => index===0?`<strong>${escapeHtml(displayValue(item,key)||"—")}</strong>`:`<span>${escapeHtml(displayValue(item,key)||"—")}</span>`).join("")}${item.pending?'<span>● 待上传</span>':''}</span></button>`;
}

function pairingCard(record) {
  const mother = byId(ENTITY.ITEM, record.motherLocalId), father = byId(ENTITY.ITEM, record.fatherLocalId);
  return `<button class="data-card" data-open-record="${record.localId}"><span class="data-card-image">×</span><span class="data-card-body"><strong>${escapeHtml(recordName(record))}</strong><span>${escapeHtml(recordName(mother))} × ${escapeHtml(recordName(father))}</span><span>${escapeHtml(record.pollinationDate||"日期未填")}</span></span></button>`;
}

function renderViews() {
  const records = filteredRecords();
  const table = $("#desktop-table"), cards = $("#desktop-cards"), mobile = $("#mobile-grid");
  table.classList.toggle("hidden", state.preferences.desktopView !== "table");
  cards.classList.toggle("active", state.preferences.desktopView === "cards");
  $$("[data-desktop-view]").forEach(button => button.classList.toggle("active", button.dataset.desktopView === state.preferences.desktopView));
  cards.style.setProperty("--desktop-columns", state.preferences.desktopColumns);
  mobile.style.setProperty("--mobile-columns", state.preferences.mobileColumns);
  if (state.entity === ENTITY.ITEM) {
    table.innerHTML = renderItemTable(records);
    cards.innerHTML = records.map(record => itemCard(record)).join("");
    mobile.innerHTML = records.map(record => itemCard(record,true)).join("");
  } else {
    table.innerHTML = renderPairingTable(records);
    cards.innerHTML = records.map(pairingCard).join("");
    mobile.innerHTML = records.map(pairingCard).join("");
  }
  $("#empty-state").hidden = records.length > 0;
}

function renderItemTable(records) {
  return `<table><thead><tr><th>名称</th><th>正式编号</th><th>分类</th><th>入手日期</th><th>来源</th><th>价格</th><th>数量</th><th>状态</th><th>录入类型</th><th>同步</th><th class="row-actions">操作</th></tr></thead><tbody>${records.map(item => `<tr data-id="${item.localId}"><td class="name-cell">${escapeHtml(recordName(item))}</td><td>${escapeHtml(item.notionUniqueId||"—")}</td><td>${escapeHtml(categoryLabel(item)||"—")}</td><td>${escapeHtml(item.acquisitionDate||"—")}</td><td>${escapeHtml(item.source||"—")}</td><td>${escapeHtml(formatPrice(item)||"—")}</td><td>${escapeHtml(item.quantity??1)}</td><td>${escapeHtml(item.status||"—")}</td><td>${escapeHtml(item.entryType||"—")}</td><td>${item.pending?'待上传':'已同步'}</td><td class="row-actions"><button data-open-record="${item.localId}">编辑</button></td></tr>`).join("")}</tbody></table>`;
}

function renderPairingTable(records) {
  return `<table><thead><tr><th>记录名称</th><th>母本</th><th>父本</th><th>授粉日期</th><th>结种／收种日期</th><th>子代</th><th>同步</th><th class="row-actions">操作</th></tr></thead><tbody>${records.map(record => `<tr><td>${escapeHtml(recordName(record))}</td><td>${escapeHtml(recordName(byId(ENTITY.ITEM,record.motherLocalId)))}</td><td>${escapeHtml(recordName(byId(ENTITY.ITEM,record.fatherLocalId)))}</td><td>${escapeHtml(record.pollinationDate||"—")}</td><td>${escapeHtml(record.harvestDate||"—")}</td><td>${escapeHtml((record.childLocalIds||[]).map(id=>recordName(byId(ENTITY.ITEM,id))).join("、")||"—")}</td><td>${record.pending?'待上传':'已同步'}</td><td class="row-actions"><button data-open-record="${record.localId}">编辑</button></td></tr>`).join("")}</tbody></table>`;
}

function openOnboarding(step = "token", options = {}) {
  const dialog = $("#onboarding-dialog");
  if (!dialog.open) dialog.showModal();
  if (step === "token") renderTokenStep(options.update);
  if (step === "unlock") renderUnlockStep(options.after || null);
  if (step === "choice") renderConnectionChoice();
  if (step === "create") renderCreateStep();
  if (step === "connect") renderConnectStep();
}

function renderTokenStep(update = false) {
  $("#onboarding-title").textContent = update ? "更新 Notion Integration Token" : "先配置 Notion Integration Token";
  $("#onboarding-body").innerHTML = `<p>Token 是敏感认证凭证，与 Database ID、Data Source ID 和 Property ID 分开保存。请设置一个本机解锁口令；口令本身不会持久化。</p><label>Notion Integration Token<input id="token-input" type="password" autocomplete="off" spellcheck="false"></label><label>本机凭证口令<input id="vault-passphrase" type="password" autocomplete="new-password" minlength="8"></label><label>确认本机口令<input id="vault-passphrase-confirm" type="password" autocomplete="new-password" minlength="8"></label><div class="form-actions"><button id="save-token" class="primary">加密保存 Token</button></div>`;
}

function renderUnlockStep(after) {
  state.pendingCredentialAction = after;
  $("#onboarding-title").textContent = "解锁本机 Notion 凭证";
  $("#onboarding-body").innerHTML = `<p>无需重新输入 Token。请输入保存 Token 时设置的本机口令；可使用浏览器密码管理器保存和自动填充该口令。</p><label>本机凭证口令<input id="unlock-passphrase" type="password" autocomplete="current-password"></label><div class="form-actions"><button id="unlock-cancel">取消</button><button id="unlock-submit" class="primary">解锁</button></div>`;
}

function renderConnectionChoice() {
  $("#onboarding-title").textContent = "选择 PWA Database";
  $("#onboarding-body").innerHTML = `<p>Token 已配置。新设备和首个设备都必须先完成凭证配置，再选择以下操作。</p><div class="choice-grid"><button class="choice-card" data-onboarding="create"><strong>创建新的 PWA Database</strong><span>在已授权给 Integration 的空白 Notion Page 下创建四个 Data Source。</span></button><button class="choice-card" data-onboarding="connect"><strong>连接已有 PWA Database</strong><span>验证四个 Data Source 和全部 Property，不匹配时停止。</span></button></div>`;
}

function renderCreateStep() {
  $("#onboarding-title").textContent = "创建新的 PWA Database";
  $("#onboarding-body").innerHTML = `<p>请先在 Notion 中将一个空白 Page 授权给当前 Integration，然后粘贴该 Page 的 URL 或 ID。中断时会保留恢复信息，不会盲目重复建库。</p><label>已授权的空白 Page URL / ID<input id="parent-page-input" autocomplete="off"></label><div id="onboarding-progress" class="details-box" hidden></div><div class="form-actions"><button data-onboarding="choice">返回</button><button id="create-database" class="primary">开始初始化</button></div>`;
}

function renderConnectStep() {
  $("#onboarding-title").textContent = "连接已有 PWA Database";
  $("#onboarding-body").innerHTML = `<p>Integration 必须已被授权访问该 Database。系统只验证并建立 ID 映射，不会改写不匹配的远程 Schema，也不会新建替代数据库。</p><label>PWA Database URL / ID<input id="database-input" autocomplete="off"></label><div id="onboarding-progress" class="details-box" hidden></div><div class="form-actions"><button data-onboarding="choice">返回</button><button id="connect-database" class="primary">验证并连接</button></div>`;
}

function onboardingProgress(message) { const el = $("#onboarding-progress"); if (el) { el.hidden = false; el.textContent = message; } }

async function saveToken() {
  const token = $("#token-input").value, passphrase = $("#vault-passphrase").value;
  if (passphrase !== $("#vault-passphrase-confirm").value) return toast("两次输入的本机口令不一致");
  try { await credentials.save(token, passphrase); toast("Token 已加密保存于本机"); state.connection ? $("#onboarding-dialog").close() : openOnboarding("choice"); }
  catch (error) { toast(error.message, 4200); }
}

async function unlockToken() {
  try {
    await credentials.unlock($("#unlock-passphrase").value);
    const after = state.pendingCredentialAction; state.pendingCredentialAction = null;
    $("#onboarding-dialog").close(); setBanner("ok", "凭证已解锁；普通浏览仍只读本机数据");
    if (after) await after(); else if (!state.connection) openOnboarding("choice");
  } catch (error) { toast(error.message, 4200); }
}

async function requireCredential(action) {
  if (!state.connection) {
    if (credentials.isUnlocked()) openOnboarding("choice");
    else if (await credentials.hasVault()) openOnboarding("unlock", { after: () => openOnboarding("choice") });
    else openOnboarding("token");
    return false;
  }
  if (!credentials.isUnlocked()) { openOnboarding("unlock", { after: action }); return false; }
  return true;
}

async function createDatabase() {
  if (state.connectionBusy) return toast("已有连接操作正在进行");
  if (state.connection) {
    const proceed = await localDb.hasPending(state.connection.databaseId)
      ? await confirmWorkspaceRemoval("创建并切换到新 Database")
      : confirm("创建成功后会替换当前 Database 连接并删除当前本地 Workspace。确定开始创建吗？");
    if (!proceed) { $("#onboarding-dialog").close(); setBanner("ok", "已取消创建；原连接与本地 Workspace 保持不变"); return; }
  }
  state.connectionBusy = true;
  try {
    onboardingProgress("准备初始化…");
    const recoveries = await localDb.getInitializationRecoveries();
    if (recoveries.length > 1) throw new Error("发现多个目标 Database 的初始化恢复点，目标身份不明确；请先使用“连接已有 Database”确认目标。");
    const recovery = recoveries.length === 1 && confirm(`发现 Database ${recoveries[0].targetDatabaseId} 的未完成初始化。是否恢复，避免重复建库？`) ? recoveries[0] : null;
    const progress = async (message, partial) => {
      onboardingProgress(message);
      if (partial?.databaseId) await localDb.putInitializationRecovery(partial.databaseId, partial);
    };
    const connection = recovery
      ? await notionApi.resumeInitialization(recovery,progress)
      : await notionApi.initializeDatabase($("#parent-page-input").value,progress);
    await commitConnectionSwitch(connection);
    await localDb.removeInitializationRecovery(connection.databaseId);
    $("#onboarding-dialog").close(); setBanner("ok", "初始化完成；尚未上传任何本地业务记录"); renderSettings();
  } catch (error) { onboardingProgress(error.message); setBanner("error", error.message); }
  finally { state.connectionBusy = false; }
}

async function connectDatabase() {
  if (state.connectionBusy) return toast("已有连接操作正在进行");
  state.connectionBusy = true;
  try {
    onboardingProgress("正在 Retrieve Database 与四个 Data Source Schema…");
    const connection = await notionApi.connectDatabase($("#database-input").value);
    if (!(await confirmWorkspaceRemoval(connection.databaseId === state.connection?.databaseId ? "重新连接同一 Database" : "切换 Database"))) {
      $("#onboarding-dialog").close(); setBanner("ok", "已取消切换；原连接与本地 Workspace 保持不变"); return;
    }
    await commitConnectionSwitch(connection);
    $("#onboarding-dialog").close(); setBanner("ok", "已连接；请主动点击“刷新”下载远程业务数据"); renderSettings();
  } catch (error) { onboardingProgress(error.message); setBanner("error", error.message); }
  finally { state.connectionBusy = false; }
}

async function disconnectDatabase() {
  if (!state.connection || state.connectionBusy) return;
  if (!(await confirmWorkspaceRemoval("断开当前 Database"))) return;
  state.connectionBusy = true;
  try {
    await commitConnectionSwitch(null);
    $("#settings-dialog").close();
    setBanner("warning", "Database 已断开，本地 Workspace 已删除；已保存 Token 仍保留");
    if (credentials.isUnlocked()) openOnboarding("choice");
    else openOnboarding(await credentials.hasVault() ? "unlock" : "token", { after: () => openOnboarding("choice") });
  } catch (error) { setBanner("error", `断开失败，原连接与 Workspace 已保留：${error.message}`); }
  finally { state.connectionBusy = false; }
}

function renderSettings() {
  const config = state.connection;
  $("#connection-details").innerHTML = config ? `<span>Database ID：${escapeHtml(config.databaseId)}</span><span>API Version：${escapeHtml(config.notionVersion)}</span><span>Schema Version：${escapeHtml(config.schemaVersion)}</span><span>凭证状态：${credentials.isUnlocked()?"已解锁":"已锁定"}</span>` : "本设备尚未连接 PWA Database。";
}

function renderDisplaySettings() {
  $("#mobile-columns").value = state.preferences.mobileColumns;
  $("#desktop-columns").value = state.preferences.desktopColumns;
  $("#display-field-list").innerHTML = state.preferences.fieldOrder.map((key,index) => {
    const field = ITEM_DISPLAY_FIELDS.find(item => item.key === key);
    return `<div class="display-row"><input type="checkbox" data-display-field="${key}" ${state.preferences.fields.includes(key)?'checked':''}><span>${escapeHtml(field.label)}</span><button type="button" data-display-move="${key}" data-direction="-1" ${index===0?'disabled':''}>↑</button><button type="button" data-display-move="${key}" data-direction="1" ${index===state.preferences.fieldOrder.length-1?'disabled':''}>↓</button></div>`;
  }).join("");
}

function itemOptions(selected = "", exclude = "") { return state.workspace.items.filter(item => item.localId !== exclude).map(item => `<option value="${item.localId}" ${item.localId===selected?'selected':''}>${escapeHtml(recordName(item))} ${item.notionUniqueId?`(${escapeHtml(item.notionUniqueId)})`:""}</option>`).join(""); }
function subOptions(selected = "") { return [...state.workspace.majorCategories].sort((a,b)=>a.sort-b.sort).map(major => `<optgroup label="${escapeHtml(recordName(major))}">${state.workspace.subCategories.filter(sub=>sub.majorLocalId===major.localId).sort((a,b)=>a.sort-b.sort).map(sub=>`<option value="${sub.localId}" ${sub.localId===selected?'selected':''}>${escapeHtml(recordName(sub))}</option>`).join("")}</optgroup>`).join(""); }

function openRecord(localId = null) {
  state.editingId = localId;
  const record = localId ? byId(state.entity, localId) : null;
  $("#record-kind").textContent = APP_SCHEMA[state.entity].title;
  $("#record-title").textContent = recordName(record);
  $("#delete-local").hidden = !record;
  if (state.entity === ENTITY.ITEM) renderItemForm(record); else renderPairingForm(record);
  $("#record-dialog").showModal();
}

function genealogy(item) {
  let generation = 0, cursor = item, original = item, visited = new Set();
  while (cursor?.directSourceLocalId && !visited.has(cursor.localId)) { visited.add(cursor.localId); cursor = byId(ENTITY.ITEM,cursor.directSourceLocalId); if (cursor) { generation += 1; original = cursor; } }
  return { generation, original };
}

function reversePairings(itemId) {
  return state.workspace.pairings.filter(record => record.motherLocalId===itemId || record.fatherLocalId===itemId || (record.childLocalIds||[]).includes(itemId));
}

function renderItemForm(item) {
  state.photoDraft = item ? itemPhotos(item).map(photo => ({...photo})) : [];
  const lineage = item ? genealogy(item) : null, pairings = item ? reversePairings(item.localId) : [];
  $("#record-fields").innerHTML = `<div class="record-meta">${item?.notionPageId?`<span>Page ID：${escapeHtml(item.notionPageId)}</span><span>正式编号：${escapeHtml(item.notionUniqueId||"等待 Notion 返回")}</span>`:'<span>本地 UUID：保存后生成</span>'}${lineage?`<span>代数：${lineage.generation}</span><span>原株：${escapeHtml(recordName(lineage.original))}</span>`:""}${pairings.length?`<span>相关配对：${pairings.length}</span>`:""}</div><div class="form-layout">
    <label class="form-control full">名称<input name="name" value="${escapeHtml(item?.name||"")}"></label>
    <label class="form-control">小分类（必选）<select name="subLocalId" required><option value="">请选择</option>${subOptions(item?.subLocalId)}</select></label>
    <label class="form-control">入手日期<input name="acquisitionDate" type="date" value="${escapeHtml(item?.acquisitionDate||"")}"></label>
    <label class="form-control full">来源<input name="source" value="${escapeHtml(item?.source||"")}"></label>
    <label class="form-control">价格<input name="price" type="number" step="0.01" min="0" value="${escapeHtml(item?.price??"")}"></label>
    <label class="form-control">货币<select name="currency">${["JPY","CNY","USD"].map(value=>`<option ${value===(item?.currency||"JPY")?'selected':''}>${value}</option>`).join("")}</select></label>
    <label class="form-control">数量<input name="quantity" type="number" min="0" value="${escapeHtml(item?.quantity??1)}"></label>
    <label class="form-control">状态<select name="status">${["在库","培育中","已售出","已枯失","其他"].map(value=>`<option ${value===(item?.status||"在库")?'selected':''}>${value}</option>`).join("")}</select></label>
    <label class="form-control">录入类型<select name="entryType">${["播种苗","成品"].map(value=>`<option ${value===(item?.entryType||"成品")?'selected':''}>${value}</option>`).join("")}</select></label>
    <label class="form-control">扦插日期<input name="cuttingDate" type="date" value="${escapeHtml(item?.cuttingDate||"")}"></label>
    <label class="form-control full">直接来源（最多一个）<select name="directSourceLocalId"><option value="">无</option>${itemOptions(item?.directSourceLocalId,item?.localId)}</select></label>
    <div class="form-control full"><span>照片（最多 5 张，第一张为主图）</span><label class="photo-picker"><input id="record-photo-input" type="file" accept="image/*,.heic,.heif" multiple>选择照片</label><div id="record-photo-strip" class="photo-strip">${renderPhotoDraft()}</div></div>
    ${item?.notionPageUrl?`<div class="form-control full qr-panel"><span>正式 Notion 页面二维码</span>${qrSvg(notionLink(item))}<a href="${escapeHtml(notionLink(item))}" target="_blank" rel="noreferrer">打开 Notion 页面</a></div>`:""}
  </div>`;
}

function renderPhotoDraft() { return state.photoDraft.map((photo,index) => `<div class="photo-tile"><img src="${escapeHtml(photoUrl(photo))}" alt=""><button type="button" data-photo-remove="${photo.localId}">×</button>${index?`<button type="button" data-photo-primary="${photo.localId}" style="top:auto;bottom:3px;left:3px;right:auto">设首</button>`:""}</div>`).join(""); }
function refreshPhotoDraft() { const el = $("#record-photo-strip"); if (el) el.innerHTML = renderPhotoDraft(); }

function renderPairingForm(record) {
  const selectedChildren = new Set(record?.childLocalIds || []);
  $("#record-fields").innerHTML = `<div class="record-meta">${record?.notionPageId?`<span>Page ID：${escapeHtml(record.notionPageId)}</span>`:'<span>本地记录</span>'}</div><div class="form-layout">
    <label class="form-control full">记录名称（留空时自动生成）<input name="name" value="${escapeHtml(record?.name||"")}"></label>
    <label class="form-control">母本（必选）<select name="motherLocalId" required><option value="">请选择</option>${itemOptions(record?.motherLocalId)}</select></label>
    <label class="form-control">父本（必选）<select name="fatherLocalId" required><option value="">请选择</option>${itemOptions(record?.fatherLocalId)}</select></label>
    <label class="form-control">授粉日期<input name="pollinationDate" type="date" value="${escapeHtml(record?.pollinationDate||"")}"></label>
    <label class="form-control">结种／收种日期<input name="harvestDate" type="date" value="${escapeHtml(record?.harvestDate||"")}"></label>
    <label class="form-control full">子代（可多选）<select class="relation-select" name="childLocalIds" multiple>${state.workspace.items.map(item=>`<option value="${item.localId}" ${selectedChildren.has(item.localId)?'selected':''}>${escapeHtml(recordName(item))}</option>`).join("")}</select></label>
  </div>`;
}

async function saveRecordLocal() {
  const session = captureSession();
  const form = $("#record-form");
  if (!form.reportValidity()) return null;
  const existing = state.editingId ? byId(state.entity,state.editingId) : null;
  let record = existing ? {...existing} : createLocalRecord(state.entity);
  if (state.entity === ENTITY.ITEM) {
    const values = Object.fromEntries(new FormData(form).entries());
    Object.assign(record, {
      name: values.name.trim(), subLocalId: values.subLocalId, acquisitionDate: values.acquisitionDate,
      source: values.source.trim(), price: values.price === "" ? null : Number(values.price), currency: values.currency,
      quantity: Number(values.quantity || 1), status: values.status, entryType: values.entryType,
      directSourceLocalId: values.directSourceLocalId || null, cuttingDate: values.cuttingDate
    });
    if (wouldCreateSourceCycle(record.localId, record.directSourceLocalId, state.workspace.items)) return toast("直接来源会形成循环，已阻止保存"), null;
    const previousPhotoIds = existing?.photoIds || [];
    const oldIds = new Set(previousPhotoIds);
    record.photoIds = state.photoDraft.map(photo => photo.localId);
    record.photosChanged = record.photoIds.length !== previousPhotoIds.length || record.photoIds.some((id,index) => id !== previousPhotoIds[index]);
    for (const [index, draftPhoto] of state.photoDraft.entries()) {
      session.assertCurrent();
      const photo = { ...draftPhoto, order: index, itemLocalId: record.localId };
      if (photo.blob && !photo.fileUploadId) photo.pending = true;
      await localDb.put("photos", photo, session.workspaceId);
      oldIds.delete(photo.localId);
    }
    for (const removedId of oldIds) { session.assertCurrent(); await localDb.remove("photos",removedId,session.workspaceId); }
    if (!existing && state.photoDraft.length) record.photosChanged = true;
  } else {
    const values = Object.fromEntries(new FormData(form).entries());
    const mother = byId(ENTITY.ITEM,values.motherLocalId), father = byId(ENTITY.ITEM,values.fatherLocalId);
    Object.assign(record, {
      name: values.name.trim() || `${recordName(mother)} × ${recordName(father)}${values.pollinationDate?` · ${values.pollinationDate}`:""}`,
      motherLocalId: values.motherLocalId, fatherLocalId: values.fatherLocalId,
      pollinationDate: values.pollinationDate, harvestDate: values.harvestDate,
      childLocalIds: [...form.elements.childLocalIds.selectedOptions].map(option=>option.value)
    });
  }
  record.dirty=true; record.pending=true; record.uploadError=null; record.updatedAt=new Date().toISOString();
  session.assertCurrent(); await localDb.put(state.entity,record,session.workspaceId); state.editingId=record.localId;
  await reloadWorkspace(); session.assertCurrent();
  const visible = filteredRecords().some(item => item.localId === record.localId);
  toast(visible ? "已保存到本机 IndexedDB；未自动上传" : `已保存到本机；当前筛选隐藏了该记录${state.entity===ENTITY.ITEM&&categoryLabel(record)?`（${categoryLabel(record)}）`:""}`, 4200);
  return record;
}

async function saveAndUpload() {
  const record = await saveRecordLocal(); if (!record) return;
  if (!(await requireCredential(() => uploadCurrent(record)))) return;
  await uploadCurrent(record);
}

async function uploadCurrent(record, force = false) {
  const context = captureSession();
  try {
    setBanner("warning", `正在上传“${recordName(record)}”…`);
    await syncCoordinator.uploadRecord(state.entity,record.localId,state.connection,{force,context});
    context.assertCurrent(); await reloadWorkspace(); context.assertCurrent(); $("#record-dialog").close(); setBanner("ok","当前记录及必要依赖已上传");
  } catch (error) {
    try { context.assertCurrent(); } catch { return; }
    const failed = byId(state.entity, record.localId);
    if (failed) { context.assertCurrent(); failed.uploadError = error.message; await localDb.put(state.entity, failed, context.workspaceId); }
    if (error.code === "local_remote_conflict" && confirm(`${error.message}\n\n确定以本地版本覆盖 Notion 吗？`)) return uploadCurrent(record,true);
    setBanner("error",error.message); toast(error.message,5000);
  }
}

async function refreshRemote() {
  if (!(await requireCredential(refreshRemote))) return;
  const context = captureSession();
  try {
    setBanner("warning","正在从 Notion 分页读取；不会上传本地数据…");
    state.refreshDraft = await syncCoordinator.fetchRemoteWorkspace(state.connection, context);
    renderRefreshPreview(); $("#refresh-dialog").showModal(); setBanner("ok","远程读取完成，等待用户决定是否更新本地");
  } catch (error) { try { context.assertCurrent(); } catch { return; } setBanner("error",error.message); toast(error.message,5000); }
}

function renderRefreshPreview() {
  const {summary} = state.refreshDraft;
  $("#refresh-preview").innerHTML = `<div class="refresh-summary"><div><strong>${summary.additions}</strong>远程新增</div><div><strong>${summary.remoteChanges}</strong>远程变化</div><div><strong>${summary.conflicts.length}</strong>双边冲突</div><div><strong>${summary.remoteDeletes.length}</strong>远程缺失</div></div><p>刷新只更新本地，不会上传。远程缺失仅作提示，应用 Refresh 后仍会保留本地记录、照片、Relation 和待上传状态。</p>${summary.conflicts.length?`<div class="conflict-list">${summary.conflicts.map(conflict=>`<label class="conflict-row"><span>${escapeHtml(conflict.name)}</span><select data-conflict-choice="${conflict.localId}"><option value="local">保留本地</option><option value="remote">采用远程</option></select></label>`).join("")}</div>`:'<p>没有双边冲突。</p>'}${summary.remoteDeletes.length?`<p>远程缺失（不会删除本地）：${summary.remoteDeletes.map(item=>escapeHtml(item.name)).join("、")}</p>`:""}`;
}

async function applyRefresh() {
  let context;
  try {
    context = captureSession();
    const choices = Object.fromEntries($$("[data-conflict-choice]").map(select=>[select.dataset.conflictChoice,select.value]));
    await syncCoordinator.applyRemote(state.connection,state.refreshDraft,choices,context); state.refreshDraft=null; $("#refresh-dialog").close(); await reloadWorkspace(); setBanner("ok","已按用户选择更新本地；远程缺失记录已保留，未上传任何数据");
  } catch (error) { if (context) { try { context.assertCurrent(); } catch { return; } } setBanner("error", error.message); toast(error.message, 5000); }
}

async function uploadPending() {
  if (!(await requireCredential(uploadPending))) return;
  let context;
  try {
    context = captureSession();
    setBanner("warning","正在上传本地待上传变化；不会先执行刷新…");
    const results = await syncCoordinator.uploadPending(state.connection,context,message=>setBanner("warning",message));
    context.assertCurrent(); await reloadWorkspace(); context.assertCurrent();
    if (results.failed.length) { const first=results.failed[0]; setBanner("error",`${results.uploaded} 条成功，${results.failed.length} 条失败：${first.error.message}`); if(first.error.code==="local_remote_conflict"&&confirm(`${first.error.message}\n\n确定以本地版本覆盖 Notion 吗？`)){await syncCoordinator.uploadRecord(first.entity,first.localId,state.connection,{force:true,context});return uploadPending();} }
    else setBanner("ok",`已上传 ${results.uploaded} 条本地变化`);
  } catch (error) { if (context) { try { context.assertCurrent(); } catch { return; } } setBanner("error", error.message); toast(error.message, 5000); }
}

async function addCategory(type) {
  const name = prompt(`输入${type===ENTITY.MAJOR?"大分类":"小分类"}名称：`); if (!name?.trim()) return;
  const list = entityList(type);
  if (list.some(record=>record.name.trim().toLocaleLowerCase("zh-CN")===name.trim().toLocaleLowerCase("zh-CN"))) return toast("同类分类名称不能重复");
  if (type===ENTITY.SUB && !state.selectedMajorId) return toast("请先选择或新增大分类");
  const record=createLocalRecord(type,{name:name.trim(),sort:Math.max(0,...list.map(item=>item.sort||0))+10});
  if(type===ENTITY.SUB)record.majorLocalId=state.selectedMajorId;
  await localDb.put(type,record); await reloadWorkspace();
  if(type===ENTITY.MAJOR)state.selectedMajorId=record.localId; else state.selectedSubId=record.localId;
  render();
}

function openCategoryManager(){renderCategoryManager();$("#category-dialog").showModal();}
function renderCategoryManager(){const majors=[...state.workspace.majorCategories].sort((a,b)=>a.sort-b.sort);$("#major-manager").innerHTML=`<div class="manager-list">${majors.map((record,index)=>`<div class="manager-row ${record.localId===state.selectedMajorId?'current':''}"><input data-category-name="${ENTITY.MAJOR}:${record.localId}" value="${escapeHtml(record.name)}"><button type="button" data-manage-major="${record.localId}">小分类</button><button type="button" data-category-move="${ENTITY.MAJOR}:${record.localId}" data-direction="${index===0?1:-1}">${index===0?'↓':'↑'}</button></div>`).join("")}<button type="button" data-category-add="${ENTITY.MAJOR}">＋ 新增大分类</button></div>`;const subs=state.workspace.subCategories.filter(record=>record.majorLocalId===state.selectedMajorId).sort((a,b)=>a.sort-b.sort);$("#sub-manager").innerHTML=`<div class="manager-list">${subs.map((record,index)=>`<div class="manager-row"><input data-category-name="${ENTITY.SUB}:${record.localId}" value="${escapeHtml(record.name)}"><span></span><button type="button" data-category-move="${ENTITY.SUB}:${record.localId}" data-direction="${index===0?1:-1}">${index===0?'↓':'↑'}</button></div>`).join("")}<button type="button" data-category-add="${ENTITY.SUB}">＋ 新增小分类</button></div>`;}

async function renameCategory(target,value){const[entity,id]=target.split(":"),record=byId(entity,id);if(!record||!value.trim())return renderCategoryManager();if(entityList(entity).some(item=>item.localId!==id&&item.name.trim().toLocaleLowerCase("zh-CN")===value.trim().toLocaleLowerCase("zh-CN"))){toast("同类分类名称不能重复");return renderCategoryManager();}record.name=value.trim();record.dirty=true;record.pending=true;record.updatedAt=new Date().toISOString();await localDb.put(entity,record);await reloadWorkspace();renderCategoryManager();}
async function moveCategory(target,direction){const[entity,id]=target.split(":"),record=byId(entity,id);const list=entity===ENTITY.MAJOR?[...state.workspace.majorCategories].sort((a,b)=>a.sort-b.sort):state.workspace.subCategories.filter(item=>item.majorLocalId===record.majorLocalId).sort((a,b)=>a.sort-b.sort);const index=list.findIndex(item=>item.localId===id),other=list[index+Number(direction)];if(!other)return;[record.sort,other.sort]=[other.sort,record.sort];record.dirty=record.pending=other.dirty=other.pending=true;await Promise.all([localDb.put(entity,record),localDb.put(entity,other)]);await reloadWorkspace();renderCategoryManager();}

document.addEventListener("click",async event=>{
  const entity=event.target.closest("[data-entity]");if(entity){state.entity=entity.dataset.entity;state.query="";$("#search").value="";render();return;}
  const major=event.target.closest("[data-major]");if(major){state.selectedMajorId=major.dataset.major;state.selectedSubId=null;render();return;}
  const sub=event.target.closest("[data-sub]");if(sub){state.selectedSubId=sub.dataset.sub;render();return;}
  const open=event.target.closest("[data-open-record]");if(open){openRecord(open.dataset.openRecord);return;}
  const view=event.target.closest("[data-desktop-view]");if(view){state.preferences.desktopView=view.dataset.desktopView;savePreferences();render();return;}
  const route=event.target.closest("[data-onboarding]");if(route){openOnboarding(route.dataset.onboarding);return;}
  if(event.target.id==="save-token")return saveToken();
  if(event.target.id==="unlock-submit")return unlockToken();
  if(event.target.id==="unlock-cancel")return $("#onboarding-dialog").close();
  if(event.target.id==="create-database")return createDatabase();
  if(event.target.id==="connect-database")return connectDatabase();
  const removePhoto=event.target.closest("[data-photo-remove]");if(removePhoto){state.photoDraft=state.photoDraft.filter(photo=>photo.localId!==removePhoto.dataset.photoRemove);refreshPhotoDraft();return;}
  const primaryPhoto=event.target.closest("[data-photo-primary]");if(primaryPhoto){const index=state.photoDraft.findIndex(photo=>photo.localId===primaryPhoto.dataset.photoPrimary);state.photoDraft.unshift(...state.photoDraft.splice(index,1));refreshPhotoDraft();return;}
  const displayMove=event.target.closest("[data-display-move]");if(displayMove){const index=state.preferences.fieldOrder.indexOf(displayMove.dataset.displayMove),target=index+Number(displayMove.dataset.direction);if(target>=0&&target<state.preferences.fieldOrder.length){state.preferences.fieldOrder.splice(target,0,state.preferences.fieldOrder.splice(index,1)[0]);savePreferences();renderDisplaySettings();render();}return;}
  const manageMajor=event.target.closest("[data-manage-major]");if(manageMajor){state.selectedMajorId=manageMajor.dataset.manageMajor;renderCategoryManager();return;}
  const categoryAdd=event.target.closest("[data-category-add]");if(categoryAdd){await addCategory(categoryAdd.dataset.categoryAdd);renderCategoryManager();return;}
  const categoryMove=event.target.closest("[data-category-move]");if(categoryMove)return moveCategory(categoryMove.dataset.categoryMove,categoryMove.dataset.direction);
});

document.addEventListener("change",async event=>{
  if(event.target.id==="desktop-major"){state.selectedMajorId=event.target.value||null;state.selectedSubId=null;render();return;}
  if(event.target.id==="desktop-sub"){state.selectedSubId=event.target.value||null;render();return;}
  if(event.target.id==="record-photo-input"){
    const files=[...event.target.files].slice(0,Math.max(0,5-state.photoDraft.length));
    files.forEach(file=>state.photoDraft.push({localId:crypto.randomUUID(),name:file.name,blob:file,order:state.photoDraft.length,dirty:true,pending:true}));
    if(event.target.files.length>files.length)toast("每条具体资料最多保存 5 张照片");refreshPhotoDraft();return;
  }
  if(event.target.matches("[data-display-field]")){const key=event.target.dataset.displayField;if(event.target.checked&&!state.preferences.fields.includes(key))state.preferences.fields.push(key);if(!event.target.checked)state.preferences.fields=state.preferences.fields.filter(item=>item!==key);savePreferences();render();return;}
  if(event.target.matches("[data-category-name]"))return renameCategory(event.target.dataset.categoryName,event.target.value);
});

$("#search").addEventListener("input",event=>{state.query=event.target.value;render();});
$("#add-record").addEventListener("click",()=>openRecord());
$("#add-major").addEventListener("click",()=>addCategory(ENTITY.MAJOR));
$("#add-sub").addEventListener("click",()=>addCategory(ENTITY.SUB));
$("#manage-categories").addEventListener("click",openCategoryManager);
$("#desktop-add-major").addEventListener("click",()=>addCategory(ENTITY.MAJOR));
$("#desktop-add-sub").addEventListener("click",()=>addCategory(ENTITY.SUB));
$("#desktop-manage-categories").addEventListener("click",openCategoryManager);
$("#refresh-remote").addEventListener("click",refreshRemote);
$("#upload-pending").addEventListener("click",uploadPending);
$("#open-settings").addEventListener("click",()=>{renderSettings();$("#settings-dialog").showModal();});
$("#display-settings").addEventListener("click",()=>{renderDisplaySettings();$("#display-dialog").showModal();});
$("#mobile-columns").addEventListener("change",event=>{state.preferences.mobileColumns=Number(event.target.value);savePreferences();render();});
$("#desktop-columns").addEventListener("change",event=>{state.preferences.desktopColumns=Number(event.target.value);savePreferences();render();});
$("#record-form").addEventListener("submit",async event=>{event.preventDefault();const record=await saveRecordLocal();if(record)$("#record-dialog").close();});
$("#save-upload").addEventListener("click",saveAndUpload);
$("#delete-local").addEventListener("click",async()=>{const record=byId(state.entity,state.editingId);if(record?.notionPageId)return toast("已同步记录不能仅在本地删除；远程归档将在后续明确版本处理");if(record&&confirm("仅删除这条尚未上传的本地记录？")){if(state.entity===ENTITY.ITEM)for(const id of record.photoIds||[])await localDb.remove("photos",id);await localDb.remove(state.entity,record.localId);$("#record-dialog").close();await reloadWorkspace();}});
$("#apply-refresh").addEventListener("click",applyRefresh);
$("#update-token").addEventListener("click",()=>{$("#settings-dialog").close();openOnboarding("token",{update:true});});
$("#unlock-token").addEventListener("click",()=>{$("#settings-dialog").close();openOnboarding("unlock");});
$("#create-new-database").addEventListener("click",async()=>{$("#settings-dialog").close();if(await requireCredential(()=>openOnboarding("create")))openOnboarding("create");});
$("#reconnect-database").addEventListener("click",async()=>{$("#settings-dialog").close();if(await requireCredential(()=>openOnboarding("connect")))openOnboarding("connect");});
$("#disconnect-database").addEventListener("click",disconnectDatabase);
$$('.close-settings').forEach(button=>button.addEventListener('click',()=>$("#settings-dialog").close()));
$$('.close-display').forEach(button=>button.addEventListener('click',()=>$("#display-dialog").close()));
$$('.close-record').forEach(button=>button.addEventListener('click',()=>$("#record-dialog").close()));
$$('.close-category').forEach(button=>button.addEventListener('click',()=>$("#category-dialog").close()));
$$('.close-refresh').forEach(button=>button.addEventListener('click',()=>$("#refresh-dialog").close()));

async function initialize() {
  try {
    await localDb.open();
    if (!localStorage.getItem("notion-pwa-v041-migration-complete")) {
      try {
        const migration = await localDb.migrateLegacyConfiguration();
        if (!migration.checked) throw new Error(migration.reason);
        if (!localStorage.getItem("notion-pwa-v041-display") && localStorage.getItem("notion-pwa-v03-display")) {
          localStorage.setItem("notion-pwa-v041-display", localStorage.getItem("notion-pwa-v03-display"));
        }
        localStorage.setItem("notion-pwa-v041-migration-complete", new Date().toISOString());
        state.preferences = loadPreferences();
      } catch (migrationError) {
        toast(`V0.3 非业务配置迁移失败，未写完成标记：${migrationError.message}`, 6000);
      }
    }
    state.connection=await localDb.getConnection(); localDb.setWorkspace(state.connection?.databaseId || null); await reloadWorkspace();
    if(!state.connection){setBanner("warning","请先配置 Token，再创建或连接 PWA Database");openOnboarding(await credentials.hasVault()?"unlock":"token");}
    else setBanner("ok","已加载当前空本地 Workspace；未自动请求 Notion，凭证当前已锁定");
  } catch(error){setBanner("error",`本机 IndexedDB 初始化失败：${error.message}`);}
  if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js").catch(()=>setBanner("warning","本机数据可用，但离线应用壳注册失败"));
}

initialize();

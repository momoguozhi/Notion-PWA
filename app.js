import { APP_SCHEMA, DEFAULT_DISPLAY_PREFERENCES, ENTITY, ITEM_DISPLAY_FIELDS, createLocalRecord, stripDeprecatedItemFields } from "./schema.js";
import { localDb } from "./storage.js";
import { credentials } from "./credentials.js";
import { notionApi, NotionApiError } from "./notion-api.js";
import { syncCoordinator } from "./sync.js";
import { qrSvg } from "./qr.js";
import { buildCategoryOrder, buildLocalDiagnostics, describeRecoveries, filterItemsByCategory, moveIdInOrder } from "./logic.js";

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
  uploadBusy: false,
  recordSaveBusy: false,
  recoveryParentInput: "",
  recoveryDatabaseName: "",
  diagnostics: null,
  managerMajorId: null,
  managerExpandedIds: new Set(),
  categorySortDraft: null,
  categorySortOriginal: null,
  categoryDrag: null,
  preferences: loadPreferences()
};

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("notion-pwa-v041-display") || "{}");
    const valid = new Set(ITEM_DISPLAY_FIELDS.map(field => field.key));
    const fieldOrder = [...(saved.fieldOrder || []), ...DEFAULT_DISPLAY_PREFERENCES.fieldOrder].filter((key, index, all) => valid.has(key) && all.indexOf(key) === index);
    const fields = (saved.fields || DEFAULT_DISPLAY_PREFERENCES.fields).filter(key => valid.has(key));
    return { ...structuredClone(DEFAULT_DISPLAY_PREFERENCES), ...saved, fieldOrder, fields: fields.length ? fields : [...DEFAULT_DISPLAY_PREFERENCES.fields] };
  } catch { return structuredClone(DEFAULT_DISPLAY_PREFERENCES); }
}

function savePreferences() { localStorage.setItem("notion-pwa-v041-display", JSON.stringify(state.preferences)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '\"':"&quot;" }[char])); }
function toast(message, delay = 2400) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), delay); }
function recordName(record) { return record?.name || "（未命名）"; }
function entityList(entity = state.entity) { return state.workspace[entity] || []; }
function byId(entity, id) { return state.workspace[entity].find(record => record.localId === id) || null; }
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
  if (state.connectionBusy) throw new Error("连接切换正在提交，请稍后再操作。");
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

function ensureActiveDatabase() {
  if (state.connection) return true;
  toast("请先创建或连接 PWA Database", 3600);
  return false;
}

function resetWorkspaceUi() {
  state.workspace = { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
  state.selectedMajorId = null; state.selectedSubId = null; state.query = ""; state.editingId = null;
  state.photoDraft = []; state.refreshDraft = null; state.pendingCredentialAction = null;
  state.managerMajorId = null; state.managerExpandedIds.clear(); state.categorySortDraft = null; state.categorySortOriginal = null; state.categoryDrag = null;
  $("#search").value = "";
  ["#record-dialog", "#category-dialog", "#refresh-dialog"].forEach(selector => { const dialog = $(selector); if (dialog.open) dialog.close(); });
}

function confirmConnectionChange(actionLabel) {
  if (!state.connection) return true;
  return confirm(`${actionLabel}成功后会更改 active connection；当前 Database 的本地 Workspace、业务数据、照片与 Token 都会保留。\n\n确定继续吗？`);
}

async function commitConnectionSwitch(connection) {
  const oldWorkspaceId = state.connection?.databaseId || null;
  const nextWorkspace = await localDb.loadWorkspace(connection?.databaseId || null);
  const nextSessionId = crypto.randomUUID();
  state.connectionSessionId = nextSessionId;
  try {
    await localDb.commitConnectionSwitch(oldWorkspaceId, connection, nextSessionId);
  } catch (error) {
    const recoverySessionId = crypto.randomUUID();
    state.connectionSessionId = recoverySessionId;
    localDb.setActiveSession(recoverySessionId);
    throw error;
  }
  state.connection = connection || null;
  localDb.setWorkspace(connection?.databaseId || null);
  resetWorkspaceUi();
  state.workspace = nextWorkspace;
  normalizeSelection();
  render();
}

function normalizeSelection() {
  const majors = [...state.workspace.majorCategories].sort((a,b) => a.sort-b.sort);
  if (!majors.some(record => record.localId === state.selectedMajorId)) state.selectedMajorId = null;
  const subs = state.workspace.subCategories.filter(record => record.majorLocalId === state.selectedMajorId).sort((a,b) => a.sort-b.sort);
  if (!state.selectedMajorId || !subs.some(record => record.localId === state.selectedSubId)) state.selectedSubId = null;
}

function filteredRecords() {
  const query = state.query.toLocaleLowerCase("zh-CN");
  const records = state.entity === ENTITY.ITEM
    ? filterItemsByCategory(state.workspace.items,state.workspace.subCategories,{majorId:state.selectedMajorId,subId:state.selectedSubId})
    : entityList();
  return records.filter(record => {
    if (state.entity === ENTITY.ITEM) {
      const text = [record.name, record.notionUniqueId, categoryLabel(record), record.source].join(" ").toLocaleLowerCase("zh-CN");
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
  ["add-record","add-major","add-sub","manage-categories","desktop-add-major","desktop-add-sub","desktop-manage-categories","refresh-remote"].forEach(id => { $("#"+id).disabled = !state.connection; });
  $("#upload-pending").disabled = !state.connection || state.uploadBusy;
  $("#save-upload").disabled = state.uploadBusy || state.recordSaveBusy;
  const localSave = $('#record-form button[type="submit"]');
  if (localSave) localSave.disabled = state.recordSaveBusy;
  renderCategories(); renderPending(); renderViews();
}

function renderCategories() {
  if (state.entity !== ENTITY.ITEM) return;
  const majors = [...state.workspace.majorCategories].sort((a,b) => a.sort-b.sort);
  $("#major-categories").innerHTML = `<button data-major="" class="${state.selectedMajorId?'':'active'}">全部</button>${majors.map(record => `<button data-major="${record.localId}" class="${record.localId===state.selectedMajorId?'active':''}">${escapeHtml(recordName(record))}</button>`).join("")}`;
  const subs = state.workspace.subCategories.filter(record => record.majorLocalId === state.selectedMajorId).sort((a,b) => a.sort-b.sort);
  $("#sub-categories").innerHTML = `<button data-sub="" class="${state.selectedSubId?'':'active'}">全部</button>${subs.map(record => `<button data-sub="${record.localId}" class="${record.localId===state.selectedSubId?'active':''}">${escapeHtml(recordName(record))}</button>`).join("")}`;
  $("#desktop-major").innerHTML = `<option value="">全部大分类</option>${majors.map(record => `<option value="${record.localId}" ${record.localId===state.selectedMajorId?'selected':''}>${escapeHtml(recordName(record))}</option>`).join("")}`;
  $("#desktop-sub").innerHTML = `<option value="">全部小分类</option>${subs.map(record => `<option value="${record.localId}" ${record.localId===state.selectedSubId?'selected':''}>${escapeHtml(recordName(record))}</option>`).join("")}`;
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
  return `<table><thead><tr><th>名称</th><th>正式编号</th><th>分类</th><th>入手日期</th><th>来源</th><th>价格</th><th>数量</th><th>同步</th><th class="row-actions">操作</th></tr></thead><tbody>${records.map(item => `<tr data-id="${item.localId}"><td class="name-cell">${escapeHtml(recordName(item))}</td><td>${escapeHtml(item.notionUniqueId||"—")}</td><td>${escapeHtml(categoryLabel(item)||"—")}</td><td>${escapeHtml(item.acquisitionDate||"—")}</td><td>${escapeHtml(item.source||"—")}</td><td>${escapeHtml(formatPrice(item)||"—")}</td><td>${escapeHtml(item.quantity??1)}</td><td>${item.pending?'待上传':'已同步'}</td><td class="row-actions"><button data-open-record="${item.localId}">编辑</button></td></tr>`).join("")}</tbody></table>`;
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
  if (step === "recoveries") loadRecoveryStep();
}

function renderTokenStep(update = false) {
  $("#onboarding-title").textContent = update ? "更新 Notion Integration Token" : "先配置 Notion Integration Token";
  $("#onboarding-body").innerHTML = `<p>Token 是敏感认证凭证，与 Database ID、Data Source ID 和 Property ID 分开保存。请设置一个本机解锁口令；口令本身不会持久化。</p><label>Notion Integration Token<input id="token-input" type="password" autocomplete="off" spellcheck="false"></label><label>本机凭证口令<input id="vault-passphrase" type="password" autocomplete="new-password" minlength="8"></label><label>确认本机口令<input id="vault-passphrase-confirm" type="password" autocomplete="new-password" minlength="8"></label><div id="onboarding-progress" class="details-box" hidden></div><div class="form-actions"><button type="button" class="close-onboarding">取消</button><button id="save-token" class="primary">加密保存 Token</button></div>`;
}

function renderUnlockStep(after) {
  state.pendingCredentialAction = after;
  $("#onboarding-title").textContent = "解锁本机 Notion 凭证";
  $("#onboarding-body").innerHTML = `<p>无需重新输入 Token。请输入保存 Token 时设置的本机口令；可使用浏览器密码管理器保存和自动填充该口令。</p><label>本机凭证口令<input id="unlock-passphrase" type="password" autocomplete="current-password"></label><div id="onboarding-progress" class="details-box" hidden></div><div class="form-actions"><button id="unlock-cancel">取消</button><button id="unlock-submit" class="primary">解锁</button></div>`;
}

function renderConnectionChoice() {
  $("#onboarding-title").textContent = "选择 PWA Database";
  $("#onboarding-body").innerHTML = `<p>Notion Page 只是创建位置；具体 Database 始终由 Database ID 识别。同一 Page 可以包含普通内容和多个 Database。</p><div class="choice-grid"><button type="button" class="choice-card" data-onboarding="create"><strong>创建新的 PWA Database</strong><span>输入名称，并在已授权的 Notion Page 中创建。</span></button><button type="button" class="choice-card" data-onboarding="connect"><strong>连接已有 PWA Database</strong><span>按 Database ID 验证 Schema，不匹配时停止。</span></button><button type="button" class="choice-card" data-onboarding="recoveries"><strong>未完成的初始化</strong><span>查看并继续 recovery；查看不会阻止新建。</span></button></div>`;
}

function renderCreateStep() {
  $("#onboarding-title").textContent = "创建新的 PWA Database";
  $("#onboarding-body").innerHTML = `<p>请选择已授权给 Integration 的 Notion Page 作为创建位置。该 Page 无需为空，也可以已经包含其他 Database。</p><label>Database 名称<input id="database-name-input" autocomplete="off" value="${escapeHtml(state.recoveryDatabaseName)}" required></label><label>创建位置 Page URL / ID<input id="parent-page-input" autocomplete="off" value="${escapeHtml(state.recoveryParentInput)}" required></label><div id="onboarding-progress" class="details-box" hidden></div><div class="form-actions"><button type="button" data-onboarding="recoveries">查看未完成初始化</button><button type="button" data-onboarding="choice">返回</button><button type="button" id="create-database" class="primary">开始初始化</button></div>`;
}

function renderConnectStep() {
  $("#onboarding-title").textContent = "连接已有 PWA Database";
  $("#onboarding-body").innerHTML = `<p>Integration 必须已被授权访问该 Database。系统只验证并建立 ID 映射，不会改写不匹配的远程 Schema，也不会新建替代数据库。</p><label>PWA Database URL / ID<input id="database-input" autocomplete="off"></label><div id="onboarding-progress" class="details-box" hidden></div><div class="form-actions"><button data-onboarding="choice">返回</button><button id="connect-database" class="primary">验证并连接</button></div>`;
}

function onboardingProgress(message, isError = false) { const el = $("#onboarding-progress"); if (el) { el.hidden = false; el.classList.toggle("error-box", isError); el.textContent = message; } }

function setConnectionBusy(busy, message = "") {
  state.connectionBusy = busy;
  $("#onboarding-dialog").classList.toggle("operation-busy", busy);
  $$("#onboarding-dialog button").forEach(button => { button.disabled = busy; });
  if (busy && message) onboardingProgress(message);
}

async function saveToken() {
  const token = $("#token-input").value, passphrase = $("#vault-passphrase").value;
  if (passphrase !== $("#vault-passphrase-confirm").value) {
    onboardingProgress("两次输入的本机口令不一致。", true);
    return;
  }
  try { await credentials.save(token, passphrase); toast("Token 已加密保存于本机"); state.connection ? $("#onboarding-dialog").close() : openOnboarding("choice"); }
  catch (error) { onboardingProgress(error.message, true); toast(error.message, 4200); }
}

async function unlockToken() {
  try {
    await credentials.unlock($("#unlock-passphrase").value);
    const after = state.pendingCredentialAction; state.pendingCredentialAction = null;
    $("#onboarding-dialog").close(); setBanner("ok", "凭证已解锁；普通浏览仍只读本机数据");
    if (after) await after(); else if (!state.connection) openOnboarding("choice");
  } catch (error) { onboardingProgress(error.message, true); toast(error.message, 4200); }
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

function renderRecoveryStep(recoveries) {
  $("#onboarding-title").textContent = "未完成的 Database 初始化";
  const rows = describeRecoveries(recoveries).map(label => `<div class="recovery-row"><span><strong>${escapeHtml(label.name)}</strong><small>${escapeHtml(label.status)} · Database ID：${escapeHtml(label.shortId)}</small><small>${escapeHtml(label.time)}</small></span><button type="button" data-recovery-resume="${escapeHtml(label.localId || "")}" ${label.canResume?"":"disabled"}>继续初始化</button><button type="button" data-recovery-defer="${escapeHtml(label.localId || "")}">暂不处理</button></div>`).join("");
  $("#onboarding-body").innerHTML = `<p>每条 recovery 都按目标 Database ID 独立保存。可以任选一条继续，也可以直接创建新的 Database；暂不处理不会修改或删除 recovery。</p><div class="recovery-list">${rows || '<div class="details-box">当前没有 initialization-recovery。</div>'}</div><div id="onboarding-progress" class="details-box" hidden></div><div class="form-actions"><button type="button" data-onboarding="create">创建新的 Database</button><button type="button" data-onboarding="choice">返回</button></div>`;
}

async function loadRecoveryStep() {
  try { renderRecoveryStep(await localDb.getInitializationRecoveries()); }
  catch (error) { onboardingProgress(`读取 recovery 失败：${error.message}`, true); }
}

async function createDatabase() {
  if (state.uploadBusy) return toast("Upload 正在进行，不能切换 Database");
  if (state.connectionBusy) return toast("已有连接操作正在进行");
  const parentInput = $("#parent-page-input");
  const nameInput = $("#database-name-input");
  if (parentInput) state.recoveryParentInput = parentInput.value;
  if (nameInput) state.recoveryDatabaseName = nameInput.value.trim();
  if (!state.recoveryDatabaseName) return onboardingProgress("Database 名称不能为空。", true);
  if (!state.recoveryParentInput.trim()) return onboardingProgress("请输入创建位置 Page URL / ID。", true);
  try {
    await startInitialization(null, state.recoveryParentInput, state.recoveryDatabaseName);
  } catch (error) { onboardingProgress(error.message, true); setBanner("error", error.message); }
}

function deferRecovery() {
  if (state.connectionBusy) return;
  openOnboarding("choice");
}

async function resumeRecovery(localId) {
  if (state.connectionBusy) return;
  try {
    const recovery = await localDb.getInitializationRecovery(localId);
    if (!recovery) return loadRecoveryStep();
    const databaseId = recovery.targetDatabaseId || recovery.databaseId;
    if (!databaseId) return onboardingProgress("该旧 recovery 缺少可确认的 Database ID，不能自动继续；记录已保留。", true);
    await startInitialization(recovery, recovery.parentPageId || "", recovery.databaseName || "未命名 Database");
  } catch (error) { onboardingProgress(`读取 recovery 失败：${error.message}`, true); }
}

function initializationErrorText(error, fallbackName) {
  const context = error.initializationContext || {};
  const name = context.databaseName || fallbackName || "未命名 Database";
  const stage = context.stage || "未知阶段";
  return `初始化 Database：${name}\n失败阶段：${stage}\n错误：${error.code || error.message || "unknown_error"}`;
}

function diagnosticError(error) {
  return { status: error.status || 0, code: error.code || "unknown_error", message: error.message || "", details: error.details ?? null };
}

async function startInitialization(recovery, parentPageInput, databaseName) {
  if (state.uploadBusy) return toast("Upload 正在进行，不能切换 Database");
  if (state.connectionBusy) return toast("已有连接操作正在进行");
  if (!confirmConnectionChange(recovery ? "恢复初始化并连接目标 Database" : "创建并连接新 Database")) {
    onboardingProgress("已取消；原连接、Workspace 与 recovery 保持不变。");
    return;
  }
  setConnectionBusy(true, recovery ? "正在恢复初始化，请勿关闭或返回…" : "正在初始化，请勿关闭或返回…");
  let lastContext = recovery ? { ...recovery } : { databaseName, parentPageId: parentPageInput, stage: "start" };
  const recoveryLocalId = recovery?.localId || null;
  let connectionCommitted = false;
  try {
    const progress = async (message, partial) => {
      onboardingProgress(message);
      lastContext = { ...lastContext, ...partial };
      if (partial?.databaseId) await localDb.putInitializationRecoveryRecord(recoveryLocalId, partial.databaseId, partial);
    };
    const connection = recovery
      ? await notionApi.resumeInitialization(recovery, progress)
      : await notionApi.initializeDatabase(parentPageInput, databaseName, progress);
    lastContext = { ...lastContext, databaseId: connection.databaseId, targetDatabaseId: connection.databaseId, databaseName: connection.databaseName, stage: "commit-connection", progressMessage: "正在提交本机 active connection…" };
    await localDb.putInitializationRecoveryRecord(recoveryLocalId, connection.databaseId, lastContext);
    try { await commitConnectionSwitch(connection); }
    catch (error) { error.initializationContext = { ...lastContext }; throw error; }
    connectionCommitted = true;
    try { await localDb.removeInitializationRecoveryRecord(recoveryLocalId || localDb.initializationRecoveryId(connection.databaseId)); }
    catch (cleanupError) {
      $("#onboarding-dialog").close();
      setBanner("warning", `Database“${connection.databaseName || "未命名 Database"}”已正常使用，但对应 recovery 清理失败并已保留：${cleanupError.message}`);
      renderSettings();
      return;
    }
    $("#onboarding-dialog").close(); setBanner("ok", `Database“${connection.databaseName || "未命名 Database"}”初始化完成，状态：正常使用`); renderSettings();
  } catch (error) {
    if (connectionCommitted) throw error;
    const context = error.initializationContext || lastContext;
    if (context?.databaseId) {
      try { await localDb.putInitializationRecoveryRecord(recoveryLocalId, context.databaseId, { ...context, lastError: diagnosticError(error) }); }
      catch (storageError) { error.message += `；同时无法更新 recovery：${storageError.message}`; }
    }
    const message = initializationErrorText(error, recovery?.databaseName || databaseName);
    onboardingProgress(message, true); setBanner("error", message);
  }
  finally { setConnectionBusy(false); }
}

async function connectDatabase() {
  if (state.uploadBusy) return toast("Upload 正在进行，不能切换 Database");
  if (state.connectionBusy) return toast("已有连接操作正在进行");
  if (!confirmConnectionChange("连接／切换 Database")) {
    onboardingProgress("已取消连接；原连接与 Workspace 保持不变。");
    return;
  }
  setConnectionBusy(true, "正在验证并连接，请勿关闭或返回…");
  try {
    const connection = await notionApi.connectDatabase($("#database-input").value);
    await commitConnectionSwitch(connection);
    $("#onboarding-dialog").close(); setBanner("ok", `Database“${connection.databaseName || "未命名 Database"}”已连接，状态：正常使用；请主动刷新远程业务数据`); renderSettings();
  } catch (error) { onboardingProgress(error.message, true); setBanner("error", error.message); }
  finally { setConnectionBusy(false); }
}

async function disconnectDatabase() {
  if (state.uploadBusy) return toast("Upload 正在进行，不能断开 Database");
  if (!state.connection || state.connectionBusy) return;
  if (!confirm("断开只会移除 active connection；本地 Workspace、业务数据、照片、Token 和远程 Database 均会保留。\n\n确定继续吗？")) return;
  state.connectionBusy = true;
  try {
    await commitConnectionSwitch(null);
    $("#settings-dialog").close();
    setBanner("warning", "Database 已断开；原本地 Workspace、业务数据、照片与 Token 均已保留");
    if (credentials.isUnlocked()) openOnboarding("choice");
    else openOnboarding(await credentials.hasVault() ? "unlock" : "token", { after: () => openOnboarding("choice") });
  } catch (error) { setBanner("error", `断开失败，原连接与 Workspace 已保留：${error.message}`); }
  finally { state.connectionBusy = false; }
}

function renderSettings() {
  const config = state.connection;
  const shortId = config?.databaseId ? `${config.databaseId.slice(0,8)}…${config.databaseId.slice(-6)}` : "—";
  $("#connection-details").innerHTML = config ? `<span>Database：${escapeHtml(config.databaseName || "未命名 Database")}</span><span>状态：正常使用</span><span>Database ID：${escapeHtml(shortId)}</span><span>Workspace ID：${escapeHtml(config.databaseId)}</span><span>API Version：${escapeHtml(config.notionVersion)}</span><span>Schema Version：${escapeHtml(config.schemaVersion)}</span><span>凭证状态：${credentials.isUnlocked()?"已解锁":"已锁定"}</span>` : "本设备尚未连接 PWA Database。";
  ["create-new-database","reconnect-database","disconnect-database"].forEach(id=>{$("#"+id).disabled=state.uploadBusy||state.connectionBusy;});
}

async function refreshDiagnostics() {
  const staging = await localDb.getStagingRecords();
  const recoveries = staging.filter(record => record.type === "initialization-recovery");
  const workspace = state.connection ? await localDb.loadWorkspace(state.connection.databaseId) : { majorCategories: [], subCategories: [], items: [], pairings: [], photos: [] };
  state.diagnostics = buildLocalDiagnostics({
    connection: state.connection, recoveries, staging, workspace,
    sessionId: state.connectionSessionId, connectionBusy: state.connectionBusy, uploadBusy: state.uploadBusy
  });
  $("#diagnostics-output").textContent = JSON.stringify(state.diagnostics, null, 2);
  return state.diagnostics;
}

async function copyDiagnostics() {
  try {
    const diagnostics = await refreshDiagnostics();
    await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    toast("诊断 JSON 已复制；不包含 Token、密码、Photo Blob 或业务正文");
  } catch (error) { toast(`复制诊断失败：${error.message}`, 5000); }
}

function renderDisplaySettings() {
  $("#mobile-columns").value = state.preferences.mobileColumns;
  $("#desktop-columns").value = state.preferences.desktopColumns;
  $("#display-field-list").innerHTML = state.preferences.fieldOrder.map((key,index) => {
    const field = ITEM_DISPLAY_FIELDS.find(item => item.key === key);
    return `<div class="display-row"><input type="checkbox" data-display-field="${key}" ${state.preferences.fields.includes(key)?'checked':''}><span>${escapeHtml(field.label)}</span><button type="button" data-display-move="${key}" data-direction="-1" ${index===0?'disabled':''}>↑</button><button type="button" data-display-move="${key}" data-direction="1" ${index===state.preferences.fieldOrder.length-1?'disabled':''}>↓</button></div>`;
  }).join("");
}

function itemOptions(selected = "") { return state.workspace.items.map(item => `<option value="${item.localId}" ${item.localId===selected?'selected':''}>${escapeHtml(recordName(item))} ${item.notionUniqueId?`(${escapeHtml(item.notionUniqueId)})`:""}</option>`).join(""); }
function majorOptions(selected = "") { return [...state.workspace.majorCategories].sort((a,b)=>a.sort-b.sort).map(major=>`<option value="${major.localId}" ${major.localId===selected?'selected':''}>${escapeHtml(recordName(major))}</option>`).join(""); }
function subOptionsForMajor(majorId, selected = "") { return state.workspace.subCategories.filter(sub=>sub.majorLocalId===majorId).sort((a,b)=>a.sort-b.sort).map(sub=>`<option value="${sub.localId}" ${sub.localId===selected?'selected':''}>${escapeHtml(recordName(sub))}</option>`).join(""); }

function openRecord(localId = null) {
  if (!ensureActiveDatabase()) return;
  state.editingId = localId;
  const record = localId ? byId(state.entity, localId) : null;
  $("#record-kind").textContent = APP_SCHEMA[state.entity].title;
  $("#record-title").textContent = recordName(record);
  $("#delete-local").hidden = !record;
  if (state.entity === ENTITY.ITEM) renderItemForm(record); else renderPairingForm(record);
  $("#record-dialog").showModal();
}

function reversePairings(itemId) {
  return state.workspace.pairings.filter(record => record.motherLocalId===itemId || record.fatherLocalId===itemId || (record.childLocalIds||[]).includes(itemId));
}

function renderItemForm(item) {
  state.photoDraft = item ? itemPhotos(item).map(photo => ({...photo})) : [];
  const selectedSub = item?.subLocalId ? byId(ENTITY.SUB, item.subLocalId) : null;
  const selectedMajorId = selectedSub?.majorLocalId || state.selectedMajorId || "";
  const pairings = item ? reversePairings(item.localId) : [];
  $("#record-fields").innerHTML = `<div class="record-meta">${item?.notionPageId?`<span>Page ID：${escapeHtml(item.notionPageId)}</span><span>正式编号：${escapeHtml(item.notionUniqueId||"等待 Notion 返回")}</span>`:'<span>本地 UUID：保存后生成</span>'}${pairings.length?`<span>相关配对：${pairings.length}</span>`:""}</div><div class="form-layout">
    <label class="form-control full">名称<input name="name" value="${escapeHtml(item?.name||"")}"></label>
    <label class="form-control">大分类（筛选）<span class="inline-field"><select name="majorLocalId"><option value="">请选择</option>${majorOptions(selectedMajorId)}</select><button type="button" data-inline-category="major">＋</button></span></label>
    <label class="form-control">小分类（必选）<span class="inline-field"><select name="subLocalId" required><option value="">请选择</option>${subOptionsForMajor(selectedMajorId,item?.subLocalId)}</select><button type="button" data-inline-category="sub">＋</button></span></label>
    <label class="form-control">入手日期<input name="acquisitionDate" type="date" value="${escapeHtml(item?.acquisitionDate||"")}"></label>
    <label class="form-control full">来源<input name="source" value="${escapeHtml(item?.source||"")}"></label>
    <label class="form-control">价格<input name="price" type="number" step="0.01" min="0" value="${escapeHtml(item?.price??"")}"></label>
    <label class="form-control">货币<select name="currency">${["JPY","CNY","USD"].map(value=>`<option ${value===(item?.currency||"JPY")?'selected':''}>${value}</option>`).join("")}</select></label>
    <label class="form-control">数量<input name="quantity" type="number" min="0" value="${escapeHtml(item?.quantity??1)}"></label>
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
  if (state.recordSaveBusy) { toast("当前记录正在保存，请勿重复提交"); return null; }
  state.recordSaveBusy = true; render();
  try { return await performSaveRecordLocal(); }
  finally { state.recordSaveBusy = false; render(); }
}

async function performSaveRecordLocal() {
  if (!ensureActiveDatabase()) return null;
  const session = captureSession();
  const form = $("#record-form");
  if (!form.reportValidity()) return null;
  const existing = state.editingId ? byId(state.entity,state.editingId) : null;
  let record = existing ? {...existing} : createLocalRecord(state.entity);
  if (state.entity === ENTITY.ITEM) {
    const values = Object.fromEntries(new FormData(form).entries());
    const selectedSub = byId(ENTITY.SUB, values.subLocalId);
    if (!selectedSub || selectedSub.majorLocalId !== values.majorLocalId) return toast("请选择当前大分类下的小分类"), null;
    record = stripDeprecatedItemFields(record);
    Object.assign(record, {
      name: values.name.trim(), subLocalId: values.subLocalId, acquisitionDate: values.acquisitionDate,
      source: values.source.trim(), price: values.price === "" ? null : Number(values.price), currency: values.currency,
      quantity: Number(values.quantity || 1)
    });
    const previousPhotoIds = existing?.photoIds || [];
    record.photoIds = state.photoDraft.map(photo => photo.localId);
    record.photosChanged = record.photoIds.length !== previousPhotoIds.length || record.photoIds.some((id,index) => id !== previousPhotoIds[index]);
    const photos = state.photoDraft.map((draftPhoto,index) => {
      const photo = { ...draftPhoto, order: index, itemLocalId: record.localId };
      if (photo.blob && !photo.fileUploadId) photo.pending = true;
      return photo;
    });
    if (!existing && state.photoDraft.length) record.photosChanged = true;
    record.dirty=true; record.pending=true; record.uploadError=null; record.updatedAt=new Date().toISOString();
    session.assertCurrent(); await localDb.saveItemWithPhotos(record,photos,session.workspaceId,session.sessionId); state.editingId=record.localId;
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
  if (state.entity !== ENTITY.ITEM) {
    record.dirty=true; record.pending=true; record.uploadError=null; record.updatedAt=new Date().toISOString();
    session.assertCurrent(); await localDb.put(state.entity,record,session.workspaceId,session.sessionId); state.editingId=record.localId;
  }
  await reloadWorkspace(); session.assertCurrent();
  const visible = filteredRecords().some(item => item.localId === record.localId);
  toast(visible ? "已保存到本机 IndexedDB；未自动上传" : `已保存到本机；当前筛选隐藏了该记录${state.entity===ENTITY.ITEM&&categoryLabel(record)?`（${categoryLabel(record)}）`:""}`, 4200);
  return record;
}

async function saveAndUpload() {
  if (state.uploadBusy) return toast("已有 Upload 正在进行，请等待完成");
  const record = await saveRecordLocal(); if (!record) return;
  if (!(await requireCredential(() => uploadCurrent(record)))) return;
  await uploadCurrent(record);
}

async function uploadCurrent(record, force = false) {
  if (state.uploadBusy) return toast("已有 Upload 正在进行，请等待完成");
  const context = captureSession();
  state.uploadBusy = true; render();
  try {
    setBanner("warning", `正在上传“${recordName(record)}”…`);
    await syncCoordinator.runUploadBatch(state.connection,context,() => syncCoordinator.uploadRecord(record.entity,record.localId,state.connection,{force,context}));
    context.assertCurrent(); await reloadWorkspace(); context.assertCurrent(); $("#record-dialog").close(); setBanner("ok","当前记录及必要依赖已上传");
  } catch (error) {
    try { context.assertCurrent(); } catch { return; }
    const failed = byId(record.entity, record.localId);
    if (failed) { context.assertCurrent(); failed.uploadError = error.message; await localDb.put(record.entity, failed, context.workspaceId, context.sessionId); }
    if (error.code === "local_remote_conflict" && confirm(`${error.message}\n\n确定以本地版本覆盖 Notion 吗？`)) {
      try {
        await syncCoordinator.runUploadBatch(state.connection,context,() => syncCoordinator.uploadRecord(record.entity,record.localId,state.connection,{force:true,context}));
        context.assertCurrent(); await reloadWorkspace(); $("#record-dialog").close(); setBanner("ok","已按用户确认覆盖远程记录");
        return;
      } catch (forceError) { setBanner("error",forceError.message); toast(forceError.message,5000); return; }
    }
    setBanner("error",error.message); toast(error.message,5000);
  } finally { state.uploadBusy = false; render(); }
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
  if (state.uploadBusy) return toast("已有 Upload 正在进行，请等待完成");
  if (!(await requireCredential(uploadPending))) return;
  let context;
  state.uploadBusy = true; render();
  try {
    context = captureSession();
    setBanner("warning","正在上传本地待上传变化；不会先执行刷新…");
    const results = await syncCoordinator.runUploadBatch(state.connection,context,() => syncCoordinator.uploadPending(state.connection,context,message=>setBanner("warning",message)));
    context.assertCurrent(); await reloadWorkspace(); context.assertCurrent();
    if (results.failed.length) { const first=results.failed[0]; setBanner("error",`${results.uploaded} 条成功，${results.failed.length} 条失败：${first.error.message}`); if(first.error.code==="local_remote_conflict"&&confirm(`${first.error.message}\n\n确定以本地版本覆盖 Notion 吗？`)){await syncCoordinator.runUploadBatch(state.connection,context,() => syncCoordinator.uploadRecord(first.entity,first.localId,state.connection,{force:true,context}));context.assertCurrent();await reloadWorkspace();setBanner("ok","已按用户确认覆盖冲突记录；其余 pending 保留");} }
    else setBanner("ok",`已上传 ${results.uploaded} 条本地变化`);
  } catch (error) { if (context) { try { context.assertCurrent(); } catch { return; } } setBanner("error", error.message); toast(error.message, 5000); }
  finally { state.uploadBusy = false; render(); }
}

async function addCategory(type, parentMajorId = null) {
  if (!ensureActiveDatabase()) return null;
  const majorId = parentMajorId || state.selectedMajorId;
  if (type===ENTITY.SUB && !majorId) {
    openCategoryManager();
    toast("请在分类管理中展开目标大分类后新增小分类");
    return null;
  }
  const name = prompt(`输入${type===ENTITY.MAJOR?"大分类":"小分类"}名称：`); if (!name?.trim()) return;
  const list = entityList(type);
  if (list.some(record=>record.name.trim().toLocaleLowerCase("zh-CN")===name.trim().toLocaleLowerCase("zh-CN"))) return toast("同类分类名称不能重复");
  const sortScope=type===ENTITY.SUB?list.filter(item=>item.majorLocalId===majorId):list;
  const record=createLocalRecord(type,{name:name.trim(),sort:Math.max(0,...sortScope.map(item=>item.sort||0))+10});
  if(type===ENTITY.SUB)record.majorLocalId=majorId;
  const draft=state.categorySortDraft?structuredClone(state.categorySortDraft):null;
  const original=state.categorySortOriginal?structuredClone(state.categorySortOriginal):null;
  await localDb.put(type,record); await reloadWorkspace();
  if(type===ENTITY.MAJOR){state.managerMajorId=record.localId;state.managerExpandedIds.add(record.localId);}
  else {state.managerMajorId=majorId;state.managerExpandedIds.add(majorId);}
  if($("#category-dialog").open&&draft){
    if(type===ENTITY.MAJOR){draft.majors.push(record.localId);draft.subs[record.localId]=[];original.majors.push(record.localId);original.subs[record.localId]=[];}
    else {draft.subs[majorId] ||= [];draft.subs[majorId].push(record.localId);original.subs[majorId] ||= [];original.subs[majorId].push(record.localId);}
    state.categorySortDraft=draft;state.categorySortOriginal=original;renderCategoryManager();
  }
  return record;
}

function initializeCategorySortDraft(){
  const majors=[...state.workspace.majorCategories].sort((a,b)=>a.sort-b.sort);
  state.categorySortDraft=buildCategoryOrder(majors,state.workspace.subCategories);
  state.categorySortOriginal=structuredClone(state.categorySortDraft);
  if(!majors.some(record=>record.localId===state.managerMajorId))state.managerMajorId=majors[0]?.localId||null;
  if(state.managerMajorId&&!state.managerExpandedIds.size)state.managerExpandedIds.add(state.managerMajorId);
}

function openCategoryManager(){if(!ensureActiveDatabase())return;initializeCategorySortDraft();$("#category-editor").innerHTML="";renderCategoryManager();$("#category-dialog").showModal();}

function renderCategoryManager(){
  if(!state.categorySortDraft)initializeCategorySortDraft();
  const majorById=new Map(state.workspace.majorCategories.map(record=>[record.localId,record]));
  const subById=new Map(state.workspace.subCategories.map(record=>[record.localId,record]));
  $("#major-manager").innerHTML=`<div class="category-tree">${state.categorySortDraft.majors.map(majorId=>{const major=majorById.get(majorId);if(!major)return"";const expanded=state.managerExpandedIds.has(majorId);const children=(state.categorySortDraft.subs[majorId]||[]).map(subId=>subById.get(subId)).filter(Boolean);return `<div class="category-tree-node" data-sort-row data-sort-entity="${ENTITY.MAJOR}" data-sort-id="${majorId}"><div class="manager-row major-manager-row ${majorId===state.managerMajorId?'current':''}"><button type="button" class="tree-toggle" data-category-toggle="${majorId}" aria-expanded="${expanded}">${expanded?'▾':'▸'}</button><button type="button" class="drag-handle" data-drag-handle aria-label="拖动大分类">⠿</button><span>${escapeHtml(recordName(major))}</span><button type="button" data-category-edit="${ENTITY.MAJOR}:${majorId}">编辑</button></div>${expanded?`<div class="category-children">${children.map(sub=>`<div class="manager-row sub-tree-row" data-sort-row data-sort-entity="${ENTITY.SUB}" data-sort-id="${sub.localId}" data-sort-parent="${majorId}"><span class="tree-indent"></span><button type="button" class="drag-handle" data-drag-handle aria-label="拖动小分类">⠿</button><span>${escapeHtml(recordName(sub))}</span><button type="button" data-category-edit="${ENTITY.SUB}:${sub.localId}">编辑</button></div>`).join("")}<button type="button" class="add-child" data-category-add="${ENTITY.SUB}" data-parent-major="${majorId}">＋ 新增小分类</button></div>`:""}</div>`;}).join("")}</div><div class="manager-actions"><button type="button" data-category-add="${ENTITY.MAJOR}">＋ 新增大分类</button><button type="button" id="reset-category-sort">取消排序修改</button><button type="button" id="save-category-sort" class="primary">保存排序</button></div>`;
  if(!$("#category-editor").hasChildNodes())$("#category-editor").innerHTML='<p class="muted">选择大分类或小分类的“编辑”以修改名称；小分类所属大分类也在此修改。</p>';
}

function openCategoryEditor(target){
  const[entity,id]=target.split(":"),record=byId(entity,id);if(!record)return;
  state.managerMajorId=entity===ENTITY.MAJOR?id:record.majorLocalId;
  if(state.managerMajorId)state.managerExpandedIds.add(state.managerMajorId);
  $("#category-editor").innerHTML=`<div class="category-editor-panel"><h3>编辑${entity===ENTITY.MAJOR?'大分类':'小分类'}</h3><label>名称<input id="category-edit-name" value="${escapeHtml(record.name)}"></label>${entity===ENTITY.SUB?`<label>所属大分类<select id="category-edit-major">${majorOptions(record.majorLocalId)}</select></label>`:""}<div class="form-actions"><button type="button" data-category-editor-cancel>取消</button><button type="button" class="danger" data-category-delete="${target}">删除</button><button type="button" class="primary" data-category-editor-save="${target}">保存修改</button></div></div>`;
  renderCategoryManager();
}

async function saveCategoryEdit(target){
  const[entity,id]=target.split(":"),record=byId(entity,id);if(!record)return;
  const name=$("#category-edit-name").value.trim();if(!name)return toast("分类名称不能为空");
  if(entityList(entity).some(item=>item.localId!==id&&item.name.trim().toLocaleLowerCase("zh-CN")===name.toLocaleLowerCase("zh-CN")))return toast("同类分类名称不能重复");
  const next={...record,name,dirty:true,pending:true,updatedAt:new Date().toISOString()},oldMajorId=record.majorLocalId;
  if(entity===ENTITY.SUB){const majorId=$("#category-edit-major").value;if(!majorId||!byId(ENTITY.MAJOR,majorId))return toast("请选择有效的大分类");next.majorLocalId=majorId;if(oldMajorId!==majorId)next.sort=Math.max(0,...state.workspace.subCategories.filter(sub=>sub.majorLocalId===majorId).map(sub=>sub.sort||0))+10;state.managerMajorId=majorId;state.managerExpandedIds.add(majorId);}
  const session=captureSession();session.assertCurrent();await localDb.put(entity,next,session.workspaceId,session.sessionId);await reloadWorkspace();session.assertCurrent();
  if(entity===ENTITY.SUB&&oldMajorId!==next.majorLocalId){
    for(const model of [state.categorySortDraft,state.categorySortOriginal]){model.subs[oldMajorId]=(model.subs[oldMajorId]||[]).filter(localId=>localId!==id);model.subs[next.majorLocalId] ||= [];model.subs[next.majorLocalId].push(id);}
  }
  $("#category-editor").innerHTML="";renderCategoryManager();toast("分类修改已保存到本机；未自动上传");
}

async function deleteCategory(target){
  const[entity,id]=target.split(":"),record=byId(entity,id);if(!record)return;
  if(record.notionPageId)return toast("已同步分类不能仅在本地删除；远程归档不在本版范围");
  if(entity===ENTITY.MAJOR&&state.workspace.subCategories.some(sub=>sub.majorLocalId===id))return toast("该大分类仍包含小分类，不能删除");
  if(entity===ENTITY.SUB&&state.workspace.items.some(item=>item.subLocalId===id))return toast("该小分类仍被具体资料使用，不能删除");
  if(!confirm(`删除本地未上传分类“${recordName(record)}”？`))return;
  const session=captureSession();session.assertCurrent();await localDb.remove(entity,id,session.workspaceId,session.sessionId);await reloadWorkspace();session.assertCurrent();state.managerExpandedIds.delete(id);
  for(const model of [state.categorySortDraft,state.categorySortOriginal]){if(entity===ENTITY.MAJOR){model.majors=model.majors.filter(localId=>localId!==id);delete model.subs[id];}else model.subs[record.majorLocalId]=(model.subs[record.majorLocalId]||[]).filter(localId=>localId!==id);}
  $("#category-editor").innerHTML="";renderCategoryManager();
}

function moveCategoryDraft(entity,id,parentId,targetId,after){
  const list=entity===ENTITY.MAJOR?state.categorySortDraft.majors:state.categorySortDraft.subs[parentId];
  return list ? moveIdInOrder(list,id,targetId,after) : false;
}

async function saveCategorySort(){
  const now=new Date().toISOString(),majors=[],subs=[];
  if(JSON.stringify(state.categorySortDraft.majors)!==JSON.stringify(state.categorySortOriginal.majors))state.categorySortDraft.majors.forEach((id,index)=>{const record=byId(ENTITY.MAJOR,id);if(record)majors.push({...record,sort:(index+1)*10,dirty:true,pending:true,updatedAt:now});});
  Object.entries(state.categorySortDraft.subs).forEach(([majorId,ids])=>{if(JSON.stringify(ids)!==JSON.stringify(state.categorySortOriginal.subs[majorId]||[]))ids.forEach((id,index)=>{const record=byId(ENTITY.SUB,id);if(record&&record.majorLocalId===majorId)subs.push({...record,sort:(index+1)*10,dirty:true,pending:true,updatedAt:now});});});
  if(!majors.length&&!subs.length)return toast("分类顺序没有变化");
  const session=captureSession();session.assertCurrent();await localDb.saveCategorySort(majors,subs,session.workspaceId,session.sessionId);await reloadWorkspace();session.assertCurrent();initializeCategorySortDraft();renderCategoryManager();toast("分类排序已保存到本机；未自动上传");
}

async function createInlineCategory(type) {
  const form = $("#record-form"), majorSelect = form.elements.majorLocalId, subSelect = form.elements.subLocalId;
  const name = prompt(`输入${type === ENTITY.MAJOR ? "大分类" : "小分类"}名称：`);
  if (!name?.trim()) return;
  if (type === ENTITY.SUB && !majorSelect.value) return toast("请先选择或新增大分类");
  const list = entityList(type);
  if (list.some(record => record.name.trim().toLocaleLowerCase("zh-CN") === name.trim().toLocaleLowerCase("zh-CN"))) return toast("同类分类名称不能重复");
  const session = captureSession();
  const sortScope=type===ENTITY.SUB?list.filter(item=>item.majorLocalId===majorSelect.value):list;
  const record = createLocalRecord(type,{name:name.trim(),sort:Math.max(0,...sortScope.map(item=>item.sort||0))+10});
  if (type === ENTITY.SUB) record.majorLocalId = majorSelect.value;
  session.assertCurrent(); await localDb.put(type,record,session.workspaceId,session.sessionId);
  await reloadWorkspace(); session.assertCurrent();
  majorSelect.innerHTML = `<option value="">请选择</option>${majorOptions(type === ENTITY.MAJOR ? record.localId : majorSelect.value)}`;
  if (type === ENTITY.MAJOR) {
    majorSelect.value = record.localId;
    subSelect.innerHTML = `<option value="">请选择</option>`;
  } else {
    subSelect.innerHTML = `<option value="">请选择</option>${subOptionsForMajor(majorSelect.value,record.localId)}`;
    subSelect.value = record.localId;
  }
  toast("分类已保存到本机；未自动上传");
}


document.addEventListener("click",async event=>{
  const entity=event.target.closest("[data-entity]");if(entity){state.entity=entity.dataset.entity;state.query="";$("#search").value="";render();return;}
  const major=event.target.closest("[data-major]");if(major){state.selectedMajorId=major.dataset.major||null;state.selectedSubId=null;render();return;}
  const sub=event.target.closest("[data-sub]");if(sub){state.selectedSubId=sub.dataset.sub||null;render();return;}
  const open=event.target.closest("[data-open-record]");if(open){openRecord(open.dataset.openRecord);return;}
  const view=event.target.closest("[data-desktop-view]");if(view){state.preferences.desktopView=view.dataset.desktopView;savePreferences();render();return;}
  const route=event.target.closest("[data-onboarding]");if(route){if(state.connectionBusy)return toast("当前操作正在进行，暂时不能返回");openOnboarding(route.dataset.onboarding);return;}
  if(event.target.id==="save-token")return saveToken();
  if(event.target.id==="unlock-submit")return unlockToken();
  if(event.target.id==="unlock-cancel")return $("#onboarding-dialog").close();
  if(event.target.closest(".close-onboarding")){if(state.connectionBusy)return toast("当前操作正在进行，暂时不能关闭");return $("#onboarding-dialog").close();}
  if(event.target.id==="create-database")return createDatabase();
  if(event.target.id==="connect-database")return connectDatabase();
  const resume=event.target.closest("[data-recovery-resume]");if(resume)return resumeRecovery(resume.dataset.recoveryResume);
  const defer=event.target.closest("[data-recovery-defer]");if(defer)return deferRecovery();
  const removePhoto=event.target.closest("[data-photo-remove]");if(removePhoto){state.photoDraft=state.photoDraft.filter(photo=>photo.localId!==removePhoto.dataset.photoRemove);refreshPhotoDraft();return;}
  const primaryPhoto=event.target.closest("[data-photo-primary]");if(primaryPhoto){const index=state.photoDraft.findIndex(photo=>photo.localId===primaryPhoto.dataset.photoPrimary);state.photoDraft.unshift(...state.photoDraft.splice(index,1));refreshPhotoDraft();return;}
  const displayMove=event.target.closest("[data-display-move]");if(displayMove){const index=state.preferences.fieldOrder.indexOf(displayMove.dataset.displayMove),target=index+Number(displayMove.dataset.direction);if(target>=0&&target<state.preferences.fieldOrder.length){state.preferences.fieldOrder.splice(target,0,state.preferences.fieldOrder.splice(index,1)[0]);savePreferences();renderDisplaySettings();render();}return;}
  const categoryToggle=event.target.closest("[data-category-toggle]");if(categoryToggle){const id=categoryToggle.dataset.categoryToggle;state.managerMajorId=id;if(state.managerExpandedIds.has(id))state.managerExpandedIds.delete(id);else state.managerExpandedIds.add(id);renderCategoryManager();return;}
  const categoryEdit=event.target.closest("[data-category-edit]");if(categoryEdit){openCategoryEditor(categoryEdit.dataset.categoryEdit);return;}
  const categoryAdd=event.target.closest("[data-category-add]");if(categoryAdd){await addCategory(categoryAdd.dataset.categoryAdd,categoryAdd.dataset.parentMajor||null);return;}
  const categorySave=event.target.closest("[data-category-editor-save]");if(categorySave)return saveCategoryEdit(categorySave.dataset.categoryEditorSave);
  const categoryDelete=event.target.closest("[data-category-delete]");if(categoryDelete)return deleteCategory(categoryDelete.dataset.categoryDelete);
  if(event.target.closest("[data-category-editor-cancel]")){$("#category-editor").innerHTML="";renderCategoryManager();return;}
  if(event.target.id==="save-category-sort")return saveCategorySort();
  if(event.target.id==="reset-category-sort"){initializeCategorySortDraft();renderCategoryManager();toast("未保存的排序修改已取消");return;}
  const inlineCategory=event.target.closest("[data-inline-category]");if(inlineCategory)return createInlineCategory(inlineCategory.dataset.inlineCategory==="major"?ENTITY.MAJOR:ENTITY.SUB);
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
  if(event.target.matches('#record-form [name="majorLocalId"]')){
    const subSelect=$("#record-form").elements.subLocalId;
    subSelect.innerHTML=`<option value="">请选择</option>${subOptionsForMajor(event.target.value)}`;
    subSelect.value="";
    return;
  }
});

document.addEventListener("pointerdown",event=>{
  const handle=event.target.closest("[data-drag-handle]");if(!handle)return;
  const row=handle.closest("[data-sort-row]");if(!row)return;
  event.preventDefault();
  state.categoryDrag={row,entity:row.dataset.sortEntity,id:row.dataset.sortId,parentId:row.dataset.sortParent||null,pointerId:event.pointerId};
  row.classList.add("dragging");
  handle.setPointerCapture?.(event.pointerId);
});

document.addEventListener("pointermove",event=>{
  const drag=state.categoryDrag;if(!drag||drag.pointerId!==event.pointerId)return;
  event.preventDefault();
  const target=document.elementFromPoint(event.clientX,event.clientY)?.closest("[data-sort-row]");
  if(!target||target===drag.row||target.dataset.sortEntity!==drag.entity||(target.dataset.sortParent||null)!==drag.parentId)return;
  const after=event.clientY>target.getBoundingClientRect().top+target.getBoundingClientRect().height/2;
  if(!moveCategoryDraft(drag.entity,drag.id,drag.parentId,target.dataset.sortId,after))return;
  const parent=target.parentElement;
  parent.insertBefore(drag.row,after?target.nextSibling:target);
},{passive:false});

document.addEventListener("pointerup",event=>{if(state.categoryDrag?.pointerId===event.pointerId){state.categoryDrag.row.classList.remove("dragging");state.categoryDrag=null;}});
document.addEventListener("pointercancel",event=>{if(state.categoryDrag?.pointerId===event.pointerId){state.categoryDrag.row.classList.remove("dragging");state.categoryDrag=null;}});

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
$("#open-settings").addEventListener("click",()=>{renderSettings();$("#settings-dialog").showModal();refreshDiagnostics().catch(error=>toast(`读取诊断失败：${error.message}`,5000));});
$("#display-settings").addEventListener("click",()=>{renderDisplaySettings();$("#display-dialog").showModal();});
$("#mobile-columns").addEventListener("change",event=>{state.preferences.mobileColumns=Number(event.target.value);savePreferences();render();});
$("#desktop-columns").addEventListener("change",event=>{state.preferences.desktopColumns=Number(event.target.value);savePreferences();render();});
$("#record-form").addEventListener("submit",async event=>{event.preventDefault();const record=await saveRecordLocal();if(record)$("#record-dialog").close();});
$("#record-form").addEventListener("keydown",event=>{if(state.entity===ENTITY.ITEM&&event.key==="Enter"&&!event.isComposing&&event.target.matches('input:not([type="file"]), select'))event.preventDefault();});
$("#save-upload").addEventListener("click",saveAndUpload);
$("#delete-local").addEventListener("click",async()=>{
  const session=captureSession(),record=byId(state.entity,state.editingId);
  if(record?.notionPageId)return toast("已同步记录不能仅在本地删除；远程归档将在后续明确版本处理");
  if(record&&confirm("仅删除这条尚未上传的本地记录？")){
    session.assertCurrent();
    if(state.entity===ENTITY.ITEM)await localDb.deleteItemWithPhotos(record.localId,session.workspaceId,session.sessionId);
    else await localDb.remove(state.entity,record.localId,session.workspaceId,session.sessionId);
    $("#record-dialog").close();await reloadWorkspace();
  }
});
$("#apply-refresh").addEventListener("click",applyRefresh);
$("#update-token").addEventListener("click",()=>{$("#settings-dialog").close();openOnboarding("token",{update:true});});
$("#unlock-token").addEventListener("click",()=>{$("#settings-dialog").close();openOnboarding("unlock");});
$("#create-new-database").addEventListener("click",async()=>{$("#settings-dialog").close();if(await requireCredential(()=>openOnboarding("create")))openOnboarding("create");});
$("#reconnect-database").addEventListener("click",async()=>{$("#settings-dialog").close();if(await requireCredential(()=>openOnboarding("connect")))openOnboarding("connect");});
$("#disconnect-database").addEventListener("click",disconnectDatabase);
$("#refresh-diagnostics").addEventListener("click",()=>refreshDiagnostics().catch(error=>toast(`读取诊断失败：${error.message}`,5000)));
$("#copy-diagnostics").addEventListener("click",copyDiagnostics);
$$('.close-settings').forEach(button=>button.addEventListener('click',()=>$("#settings-dialog").close()));
$$('.close-display').forEach(button=>button.addEventListener('click',()=>$("#display-dialog").close()));
$$('.close-record').forEach(button=>button.addEventListener('click',()=>$("#record-dialog").close()));
$$('.close-category').forEach(button=>button.addEventListener('click',()=>$("#category-dialog").close()));
$$('.close-refresh').forEach(button=>button.addEventListener('click',()=>$("#refresh-dialog").close()));
$("#onboarding-dialog").addEventListener("cancel",event=>{if(state.connectionBusy){event.preventDefault();toast("当前操作正在进行，暂时不能关闭");}});

async function initialize() {
  try {
    await localDb.open(); localDb.setActiveSession(state.connectionSessionId);
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
    else setBanner("ok",`已加载 Database“${state.connection.databaseName || "未命名 Database"}”的本地 Workspace，状态：正常使用；未自动请求 Notion`);
  } catch(error){setBanner("error",`本机 IndexedDB 初始化失败：${error.message}`);}
  if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js").catch(()=>setBanner("warning","本机数据可用，但离线应用壳注册失败"));
}

initialize();

/* =========================================================
   Tủ lạnh của tôi — App logic
   - Dữ liệu lưu trên Firestore (2 collections: categories, foods)
   - Toàn bộ CRUD đọc/ghi trực tiếp Firestore, không có local seed
   ========================================================= */

// ---------- Firebase SDK (lazy-loaded) ----------
const FB_SDK_VERSION = "10.12.0";
const FB_STORAGE_KEY = "food-management:firebase-config";
let fb = null; // { app, db, config, sdk }

async function loadFirebaseSDK() {
  const [appMod, fsMod] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${FB_SDK_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${FB_SDK_VERSION}/firebase-firestore.js`),
  ]);
  return { ...appMod, ...fsMod };
}

// ---------- State ----------
const state = {
  categories: [],
  foods: [],
  filter: {
    category: "all",
    search: "",
    sort: "oldest",
  },
  editingId: null,
  pendingDeleteId: null,
};

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const VI_DATE = new Intl.DateTimeFormat("vi-VN", {
  weekday: "long",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const VI_DATE_SHORT = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  month: "2-digit",
});

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysSince(isoDate) {
  if (!isoDate) return 0;
  const a = new Date(isoDate + "T00:00:00");
  const b = new Date(todayISO() + "T00:00:00");
  return Math.max(0, Math.round((b - a) / 86400000));
}

function relativeDay(isoDate) {
  const d = daysSince(isoDate);
  if (d === 0) return "Hôm nay";
  if (d === 1) return "Hôm qua";
  if (d < 7) return `${d} ngày trước`;
  if (d < 30) return `${Math.floor(d / 7)} tuần trước`;
  return VI_DATE_SHORT.format(new Date(isoDate));
}

function genId() {
  return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Firebase config persistence ----------
function loadConfigFromStorage() {
  try {
    const raw = localStorage.getItem(FB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveConfigToStorage(config) {
  localStorage.setItem(FB_STORAGE_KEY, JSON.stringify(config));
}
function clearConfigFromStorage() {
  localStorage.removeItem(FB_STORAGE_KEY);
}

// Parse Firebase config — accepts both strict JSON and JS object literal.
function parseFirebaseConfig(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("Vui lòng dán Firebase config");
  try {
    return JSON.parse(trimmed);
  } catch {}
  const normalized = trimmed
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
    .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(normalized);
  } catch (err) {
    throw new Error("Config không đúng định dạng JSON hoặc JS object");
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Config phải là object");
  const required = ["apiKey", "authDomain", "projectId"];
  const missing = required.filter((k) => !config[k]);
  if (missing.length) throw new Error(`Thiếu trường: ${missing.join(", ")}`);
}

// ---------- Firebase connect / disconnect ----------
async function connectFirebase(config) {
  validateConfig(config);
  const sdk = await loadFirebaseSDK();
  const appName = `food-${Date.now()}`;
  const app = sdk.initializeApp(config, appName);
  const db = sdk.getFirestore(app);
  // Verify by attempting a read on categories
  await sdk.getDocs(sdk.collection(db, "categories"));
  fb = { app, db, config, sdk };
}

async function disconnectFirebase() {
  if (!fb) return;
  try {
    await fb.sdk.deleteApp(fb.app);
  } catch (err) {
    console.warn("deleteApp failed:", err);
  }
  fb = null;
}

// ---------- Firestore data layer ----------
async function loadDataFromFirestore() {
  const { db, sdk } = fb;
  const [catSnap, foodSnap] = await Promise.all([
    sdk.getDocs(sdk.collection(db, "categories")),
    sdk.getDocs(sdk.collection(db, "foods")),
  ]);
  const categories = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const foods = foodSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { categories, foods };
}

async function loadAndApplyData() {
  const { categories, foods } = await loadDataFromFirestore();
  state.categories = categories;
  state.foods = foods.filter((f) => !f.eaten);
  fillCategoryOptions();
  renderAll();
}

function getCategoryById(id) {
  return state.categories.find((c) => c.id === id);
}

// ---------- Rendering ----------
function renderTodayLabel() {
  const txt = VI_DATE.format(new Date());
  $("#today-label").textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
}

function renderStats() {
  const foods = state.foods;
  $("#stat-total").textContent = foods.length;

  const cats = new Set(foods.map((f) => f.category));
  $("#stat-categories").textContent = cats.size;

  if (foods.length === 0) {
    $("#stat-oldest").textContent = "—";
    return;
  }
  const oldest = foods.reduce((acc, f) =>
    new Date(f.savedDate) < new Date(acc.savedDate) ? f : acc
  );
  const d = daysSince(oldest.savedDate);
  $("#stat-oldest").textContent = d === 0 ? "Hôm nay" : `${d} ngày`;
}

function renderChips() {
  const wrap = $("#chip-list");
  const counts = state.foods.reduce((acc, f) => {
    acc[f.category] = (acc[f.category] || 0) + 1;
    return acc;
  }, {});
  const all = state.foods.length;

  const items = [
    { id: "all", name: "Tất cả", emoji: "🍽️", count: all },
    ...state.categories.map((c) => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      count: counts[c.id] || 0,
    })),
  ];

  wrap.innerHTML = items
    .map(
      (c) => `
      <button type="button"
        class="chip ${state.filter.category === c.id ? "is-active" : ""}"
        data-cat="${c.id}">
        <span aria-hidden="true">${c.emoji}</span>
        <span>${escapeHtml(c.name)}</span>
        <span class="count">${c.count}</span>
      </button>`
    )
    .join("");
}

function getFilteredFoods() {
  const { category, search, sort } = state.filter;
  const term = search.trim().toLowerCase();

  let arr = state.foods.filter((f) => {
    if (category !== "all" && f.category !== category) return false;
    if (term) {
      const inName = f.name.toLowerCase().includes(term);
      const inNote = (f.notes || "").toLowerCase().includes(term);
      if (!inName && !inNote) return false;
    }
    return true;
  });

  const cmp = {
    oldest: (a, b) => new Date(a.savedDate) - new Date(b.savedDate),
    newest: (a, b) => new Date(b.savedDate) - new Date(a.savedDate),
    "name-asc": (a, b) => a.name.localeCompare(b.name, "vi"),
    "name-desc": (a, b) => b.name.localeCompare(a.name, "vi"),
  };
  arr.sort(cmp[sort] || cmp.oldest);
  return arr;
}

function renderSuggestions() {
  const wrap = $("#suggest-list");
  if (state.foods.length === 0) {
    wrap.innerHTML = `<p class="section-sub">Chưa có món nào trong tủ lạnh — hãy thêm món đầu tiên!</p>`;
    return;
  }

  const sorted = [...state.foods].sort(
    (a, b) => new Date(a.savedDate) - new Date(b.savedDate)
  );
  const picks = sorted.slice(0, 3);

  wrap.innerHTML = picks
    .map((f) => {
      const cat = getCategoryById(f.category);
      const days = daysSince(f.savedDate);
      const badge =
        days >= 3
          ? `<span class="suggest-badge">⏰ ${days} ngày</span>`
          : `<span class="suggest-badge" style="background:var(--accent-soft);color:#3F5C2C">🌿 Còn tươi</span>`;
      return `
        <div class="suggest-card" role="listitem" style="--card-accent:${cat?.color || "#D97757"}">
          <div class="suggest-emoji" style="background:${hexToSoft(cat?.color)}">${f.emoji || cat?.emoji || "🍽️"}</div>
          <div class="suggest-info">
            <p class="suggest-name">${escapeHtml(f.name)}</p>
            <div class="suggest-meta">
              <span>${escapeHtml(cat?.name || "—")}</span>
              ${badge}
            </div>
          </div>
        </div>`;
    })
    .join("");
}

function hexToSoft(hex) {
  if (!hex) return "var(--primary-soft)";
  // Convert hex to soft pastel: blend with #FFFFFF at ~88%
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const mix = (v) => Math.round(v * 0.18 + 255 * 0.82);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function renderGrid() {
  const grid = $("#food-grid");
  const list = getFilteredFoods();
  const empty = $("#empty-state");

  $("#list-count").textContent = `${list.length} món${
    state.filter.category !== "all" || state.filter.search
      ? ` (trong tổng ${state.foods.length})`
      : ""
  }`;

  if (list.length === 0) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  grid.innerHTML = list.map(cardHTML).join("");
}

function freshnessChip(days) {
  if (days >= 5) {
    return `<span class="freshness is-urgent" title="Đã lưu ${days} ngày">⚠️ Nên ăn sớm · ${days} ngày</span>`;
  }
  if (days >= 3) {
    return `<span class="freshness is-warn" title="Đã lưu ${days} ngày">⏰ ${days} ngày trước</span>`;
  }
  if (days === 0) {
    return `<span class="freshness is-fresh">🌿 Hôm nay</span>`;
  }
  return `<span class="freshness is-fresh">🌿 ${days} ngày trước</span>`;
}

function cardHTML(f) {
  const cat = getCategoryById(f.category);
  const days = daysSince(f.savedDate);
  const tint = hexToSoft(cat?.color);
  const accent = cat?.color || "#D97757";

  return `
    <article class="food-card"
      style="--card-accent:${accent};--card-tint:${tint}"
      data-id="${f.id}">
      <div class="food-head">
        <div class="food-emoji">${f.emoji || cat?.emoji || "🍽️"}</div>
        <div class="food-actions">
          <button class="icon-btn" data-action="edit" data-id="${f.id}" aria-label="Sửa món ${escapeHtml(f.name)}" title="Sửa">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button class="icon-btn" data-action="delete" data-id="${f.id}" aria-label="Xoá món ${escapeHtml(f.name)}" title="Xoá">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6"></path><path d="M14 11v6"></path>
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>

      <h3 class="food-name">${escapeHtml(f.name)}</h3>
      <span class="food-cat">${cat?.emoji || ""} ${escapeHtml(cat?.name || "Khác")}</span>

      <div class="food-meta">
        ${
          f.quantity
            ? `<span class="meta-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                ${escapeHtml(f.quantity)}
              </span>`
            : ""
        }
        ${freshnessChip(days)}
      </div>

      ${f.notes ? `<p class="food-notes">${escapeHtml(f.notes)}</p>` : ""}
    </article>
  `;
}

function renderAll() {
  renderStats();
  renderChips();
  renderSuggestions();
  renderGrid();
}

// ---------- Modal handling ----------
const modal = $("#modal");
const form = $("#food-form");

function fillCategoryOptions() {
  const sel = $("#f-category");
  sel.innerHTML = state.categories
    .map((c) => `<option value="${c.id}">${c.emoji} ${escapeHtml(c.name)}</option>`)
    .join("");
}

function openModal(food = null) {
  state.editingId = food ? food.id : null;
  $("#modal-title").textContent = food ? "Sửa món ăn" : "Thêm món ăn";

  form.reset();
  form.elements.id.value = food?.id || "";
  if (food) {
    form.elements.name.value = food.name;
    form.elements.category.value = food.category;
    form.elements.emoji.value = food.emoji || "";
    form.elements.quantity.value = food.quantity || "";
    form.elements.savedDate.value = food.savedDate || todayISO();
    form.elements.notes.value = food.notes || "";
  } else {
    form.elements.savedDate.value = todayISO();
    form.elements.category.value = state.categories[0]?.id || "";
  }

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  setTimeout(() => form.elements.name.focus(), 50);
}

function closeModal() {
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  state.editingId = null;
}

// ---------- Confirm ----------
const confirmEl = $("#confirm");
function openConfirm(id) {
  state.pendingDeleteId = id;
  confirmEl.hidden = false;
  confirmEl.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeConfirm() {
  confirmEl.hidden = true;
  confirmEl.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  state.pendingDeleteId = null;
}

// ---------- Firebase modal ----------
const fbModal = $("#fb-modal");
const fbForm = $("#fb-form");
const fbConfigInput = $("#fb-config");
const fbErrorEl = $("#fb-error");
const fbConnectBtn = $("#fb-connect-btn");

function showFbError(msg) {
  if (!msg) {
    fbErrorEl.hidden = true;
    fbErrorEl.textContent = "";
    return;
  }
  fbErrorEl.textContent = msg;
  fbErrorEl.hidden = false;
}

function openFbModal(prefillConfig = null, errorMsg = null) {
  fbConfigInput.value = prefillConfig ? JSON.stringify(prefillConfig, null, 2) : "";
  showFbError(errorMsg);
  fbModal.hidden = false;
  fbModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  setTimeout(() => fbConfigInput.focus(), 50);
}

function closeFbModal() {
  fbModal.hidden = true;
  fbModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function updateFbButtonState() {
  const btn = $("#btn-firebase");
  if (fb) {
    btn.classList.add("is-connected");
    const pid = fb.config.projectId;
    btn.title = `Đã kết nối: ${pid} · Nhấn để đăng xuất`;
    btn.setAttribute("aria-label", `Đã kết nối Firebase: ${pid}. Nhấn để đăng xuất.`);
  } else {
    btn.classList.remove("is-connected");
    btn.title = "Kết nối Firebase";
    btn.setAttribute("aria-label", "Kết nối Firebase");
  }
}

function updateAppGate() {
  const addBtn = $("#btn-add-food");
  addBtn.disabled = !fb;
  addBtn.style.opacity = fb ? "" : "0.55";
  addBtn.style.cursor = fb ? "" : "not-allowed";
}

function showNotConnectedEmpty() {
  $("#food-grid").innerHTML = "";
  $("#suggest-list").innerHTML = `<p class="section-sub">Kết nối Firebase để xem gợi ý món ăn.</p>`;
  $("#chip-list").innerHTML = "";
  $("#stat-total").textContent = "0";
  $("#stat-categories").textContent = "0";
  $("#stat-oldest").textContent = "—";
  $("#list-count").textContent = "0 món";
  $("#empty-state").hidden = false;
  $("#empty-title").textContent = "Chưa kết nối Firebase";
  $("#empty-msg").textContent =
    "Hãy kết nối Firestore để bắt đầu lưu trữ và đồng bộ món ăn trong tủ lạnh.";
  const action = $("#empty-action");
  action.textContent = "Kết nối Firebase";
  action.dataset.action = "open-fb";
}

function resetEmptyStateToDefault() {
  $("#empty-title").textContent = "Không tìm thấy món nào";
  $("#empty-msg").textContent =
    "Hãy thử thay đổi từ khoá hoặc bộ lọc, hoặc thêm món ăn mới vào tủ lạnh.";
  const action = $("#empty-action");
  action.textContent = "Thêm món mới";
  action.dataset.action = "open-add";
}

async function handleConnectSubmit(rawInput) {
  showFbError(null);
  let config;
  try {
    config = parseFirebaseConfig(rawInput);
    validateConfig(config);
  } catch (err) {
    showFbError(err.message);
    return;
  }

  fbConnectBtn.disabled = true;
  const prevLabel = fbConnectBtn.textContent;
  fbConnectBtn.textContent = "Đang kết nối...";

  try {
    if (fb) await disconnectFirebase();
    await connectFirebase(config);
    updateFbButtonState();
    updateAppGate();
    resetEmptyStateToDefault();
    await loadAndApplyData();
    saveConfigToStorage(config);
    closeFbModal();
    toast("Đã kết nối Firebase", "success");
  } catch (err) {
    console.error(err);
    await disconnectFirebase().catch(() => {});
    updateFbButtonState();
    updateAppGate();
    showFbError("Kết nối thất bại: " + (err?.message || err));
  } finally {
    fbConnectBtn.disabled = false;
    fbConnectBtn.textContent = prevLabel;
  }
}

async function handleDisconnect() {
  if (!fb) {
    openFbModal();
    return;
  }
  const prevConfig = fb.config;
  await disconnectFirebase();
  clearConfigFromStorage();
  state.foods = [];
  state.categories = [];
  fillCategoryOptions();
  updateFbButtonState();
  updateAppGate();
  showNotConnectedEmpty();
  openFbModal(prevConfig);
  toast("Đã đăng xuất Firebase");
}

// ---------- Toast ----------
let toastTimer;
function toast(message, type = "") {
  const el = $("#toast");
  el.className = `toast ${type}`;
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => (el.hidden = true), 300);
  }, 2400);
}

// ---------- Mutations (Firestore) ----------
async function upsertFood(payload) {
  if (!fb) {
    toast("Chưa kết nối Firebase", "error");
    return;
  }
  const { db, sdk } = fb;
  const isNew = !payload.id;
  const id = payload.id || genId();
  const { id: _omit, ...rest } = payload;
  const data = { ...rest, eaten: false };

  try {
    await sdk.setDoc(sdk.doc(db, "foods", id), data, { merge: true });
    if (isNew) {
      state.foods.unshift({ id, ...data });
      toast("Đã thêm món vào tủ lạnh", "success");
    } else {
      const idx = state.foods.findIndex((f) => f.id === id);
      if (idx >= 0) state.foods[idx] = { ...state.foods[idx], id, ...data };
      toast("Đã cập nhật món ăn", "success");
    }
    renderAll();
  } catch (err) {
    console.error(err);
    toast("Lỗi khi lưu: " + err.message, "error");
  }
}

async function deleteFood(id) {
  if (!fb) {
    toast("Chưa kết nối Firebase", "error");
    return;
  }
  try {
    await fb.sdk.deleteDoc(fb.sdk.doc(fb.db, "foods", id));
    state.foods = state.foods.filter((f) => f.id !== id);
    toast("Đã xoá món khỏi tủ lạnh");
    renderAll();
  } catch (err) {
    console.error(err);
    toast("Lỗi khi xoá: " + err.message, "error");
  }
}

// ---------- Event bindings ----------
function bindEvents() {
  // Add button (header)
  $("#btn-add-food").addEventListener("click", () => {
    if (!fb) {
      openFbModal();
      return;
    }
    openModal();
  });

  // Empty state add button
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action='open-add']");
    if (t) {
      if (!fb) {
        openFbModal();
        return;
      }
      openModal();
    }
    const f = e.target.closest("[data-action='open-fb']");
    if (f) openFbModal();
  });

  // Firebase status button
  $("#btn-firebase").addEventListener("click", () => {
    handleDisconnect();
  });

  // Firebase modal close
  fbModal.addEventListener("click", (e) => {
    if (e.target.closest("[data-fb-close]")) closeFbModal();
  });

  // Firebase form submit
  fbForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleConnectSubmit(fbConfigInput.value);
  });

  // Search (debounced)
  let searchTimer;
  $("#search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.filter.search = v;
      renderGrid();
    }, 160);
  });

  // Sort
  $("#sort-select").addEventListener("change", (e) => {
    state.filter.sort = e.target.value;
    renderGrid();
  });

  // Chips
  $("#chip-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    state.filter.category = btn.dataset.cat;
    renderChips();
    renderGrid();
  });

  // Card actions: edit / delete
  $("#food-grid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const food = state.foods.find((f) => f.id === id);
    if (!food) return;
    if (btn.dataset.action === "edit") openModal(food);
    if (btn.dataset.action === "delete") openConfirm(id);
  });

  // Modal close
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeModal();
  });
  confirmEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-confirm]")) closeConfirm();
  });
  $("#confirm-ok").addEventListener("click", () => {
    if (state.pendingDeleteId) deleteFood(state.pendingDeleteId);
    closeConfirm();
  });

  // ESC closes modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!modal.hidden) closeModal();
      if (!confirmEl.hidden) closeConfirm();
      if (!fbModal.hidden) closeFbModal();
    }
  });

  // Form submit
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name?.trim()) {
      toast("Vui lòng nhập tên món", "error");
      form.elements.name.focus();
      return;
    }
    const payload = {
      id: data.id || undefined,
      name: data.name.trim(),
      category: data.category,
      emoji: (data.emoji || "").trim(),
      quantity: (data.quantity || "").trim(),
      savedDate: data.savedDate || todayISO(),
      notes: (data.notes || "").trim(),
    };
    upsertFood(payload);
    closeModal();
  });
}

// ---------- Init ----------
async function init() {
  renderTodayLabel();
  bindEvents();

  const savedConfig = loadConfigFromStorage();

  if (!savedConfig) {
    updateFbButtonState();
    updateAppGate();
    showNotConnectedEmpty();
    openFbModal();
    return;
  }

  // Auto-connect with stored config
  try {
    await connectFirebase(savedConfig);
    resetEmptyStateToDefault();
    await loadAndApplyData();
    updateFbButtonState();
    updateAppGate();
  } catch (err) {
    console.error("Auto-connect failed:", err);
    await disconnectFirebase().catch(() => {});
    updateFbButtonState();
    updateAppGate();
    showNotConnectedEmpty();
    openFbModal(savedConfig, "Không kết nối được với config đã lưu: " + (err?.message || err));
  }
}

init();

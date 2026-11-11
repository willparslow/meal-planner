import { firebaseConfig, FIREBASE_VERSION } from './firebase-config.js';
import { SEED } from './seed.js';

/* ------------------------------------------------------------------ *
 *  Meal Planner — plan meals, check stock, shop offline.
 *  Data lives in ONE Firestore document (households/home) so both
 *  phones stay in sync. Firestore's offline cache keeps everything
 *  working with no signal; changes sync when signal returns.
 *  With no Firebase config it runs in "demo mode" (this phone only).
 * ------------------------------------------------------------------ */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEL = Symbol('delete');
const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

let store = null;        // demo or firebase store
let S = null;            // current household data
let meta = {};           // { fromCache, pending, exists }
let unsub = null;
let confirmFn = null;

const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const ui = {
  tab: ls.get('mp.tab') || 'plan',
  planWeek: null,
  mealsTab: 'meals',
  modal: null,           // { type: 'meal', id } | { type: 'confirm', ... } | { type: 'finish' }
  search: '',
  hideGot: ls.get('mp.hideGot') === '1',
};

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 9);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
const uniqueId = (base, taken) => { let id = base, n = 2; while (taken && taken[id]) id = `${base}-${n++}`; return id; };
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
const tick = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const todayName = DAYS[(new Date().getDay() + 6) % 7];

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function setPath(obj, path, v) {
  const ks = path.split('.'); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {}; o = o[ks[i]]; }
  if (v === DEL) delete o[ks.at(-1)]; else o[ks.at(-1)] = v;
}
function update(changes) { store.update(changes); }

/* ---------------- stores ---------------- */
function demoStore() {
  const KEY = 'mp.demo';
  let data = null;
  try { data = JSON.parse(ls.get(KEY) || 'null'); } catch { data = null; }
  let cb = null;
  const emit = () => cb && cb(data ? structuredClone(data) : null, { exists: !!data });
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} emit(); };
  return {
    kind: 'demo',
    start(fn) { cb = fn; setTimeout(emit, 0); return () => { cb = null; }; },
    seed(empty) { data = empty ? emptyData() : structuredClone(SEED); save(); },
    update(changes) { for (const [p, v] of Object.entries(changes)) setPath(data, p, v); save(); },
    replace(d) { data = d; save(); },
  };
}

async function firebaseStore() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [fbApp, fs, fa] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const fapp = fbApp.initializeApp(firebaseConfig);
  const db = fs.initializeFirestore(fapp, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  const auth = fa.getAuth(fapp);
  const ref = fs.doc(db, 'households', 'home');
  const toFs = (changes) => {
    const u = {};
    for (const [p, v] of Object.entries(changes)) u[p] = v === DEL ? fs.deleteField() : v;
    return u;
  };
  return {
    kind: 'firebase',
    auth,
    onAuth: (fn) => fa.onAuthStateChanged(auth, fn),
    signIn: (e, p) => fa.signInWithEmailAndPassword(auth, e, p),
    signUp: (e, p) => fa.createUserWithEmailAndPassword(auth, e, p),
    reset: (e) => fa.sendPasswordResetEmail(auth, e),
    async google() {
      const provider = new fa.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      // Popup only: the redirect flow breaks on iPhones when the app isn't hosted on Firebase's own domain
      await fa.signInWithPopup(auth, provider);
    },
    signOut: () => fa.signOut(auth),
    start(fn, onErr) {
      return fs.onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
        fn(snap.exists() ? snap.data() : null, { exists: snap.exists(), fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites });
      }, onErr);
    },
    seed(empty) { return fs.setDoc(ref, empty ? emptyData() : structuredClone(SEED)); },
    replace(d) { return fs.setDoc(ref, d); },
    // Not awaited: when offline, Firestore applies the change locally at once and queues it.
    update(changes) { fs.updateDoc(ref, toFs(changes)).catch((e) => toast(`Couldn't save: ${e.code || e.message}`)); },
  };
}

function emptyData() {
  return {
    ingredients: {}, meals: {}, weeks: { 1: { days: {}, daily: {} } },
    aisles: ['Fruit & Veg', 'Meat', 'Fish', 'Dairy', 'Carbs', 'Sauces', 'Breakfast', 'Other'],
    shop: { week: '1', stock: {}, got: {}, extras: {} },
  };
}

/* ---------------- derived data ---------------- */
function normalize(d) {
  d.ingredients ||= {}; d.meals ||= {}; d.weeks ||= {}; d.aisles ||= ['Other'];
  d.shop ||= {}; d.shop.stock ||= {}; d.shop.got ||= {}; d.shop.extras ||= {};
  if (!Object.keys(d.weeks).length) d.weeks['1'] = { days: {}, daily: {} };
  for (const w of Object.values(d.weeks)) { w.days ||= {}; w.daily ||= {}; }
  for (const m of Object.values(d.meals)) m.ings ||= {};
  if (!d.weeks[d.shop.week]) d.shop.week = weekIds(d)[0];
  return d;
}
const weekIds = (d = S) => Object.keys(d.weeks).sort((a, b) => Number(a) - Number(b));
const mealList = () => Object.entries(S.meals).map(([id, m]) => ({ id, ...m })).sort(byName);
const aisleOrder = () => {
  const order = [...S.aisles];
  for (const i of Object.values(S.ingredients)) if (!order.includes(i.aisle || 'Other')) order.push(i.aisle || 'Other');
  for (const x of Object.values(S.shop.extras)) if (!order.includes(x.aisle || 'Other')) order.push(x.aisle || 'Other');
  return order;
};
function weekMealIds(w) {
  const wk = S.weeks[w]; if (!wk) return [];
  // Fixed order (Mon→Sun, then every-day meals A–Z): Firestore doesn't keep map keys in a stable order
  const daily = Object.keys(wk.daily).sort((a, b) => (S.meals[a]?.name || '').localeCompare(S.meals[b]?.name || ''));
  return [...DAYS.map((d) => wk.days[d]).filter(Boolean), ...daily].filter((id) => S.meals[id]);
}
function weeksUsing(mealId) {
  return weekIds().filter((w) => weekMealIds(w).includes(mealId));
}
/** Map ingredientId -> Set of meal names that need it, for a week */
function neededFor(w) {
  const map = new Map();
  for (const mid of weekMealIds(w)) {
    for (const iid of Object.keys(S.meals[mid].ings)) {
      if (!S.ingredients[iid]) continue;
      if (!map.has(iid)) map.set(iid, new Set());
      map.get(iid).add(S.meals[mid].name);
    }
  }
  return map;
}
function shoppingItems() {
  const items = [];
  for (const [iid, meals] of neededFor(S.shop.week)) {
    if (S.shop.stock[iid]) continue;
    const i = S.ingredients[iid];
    items.push({ id: iid, name: i.name, aisle: i.aisle || 'Other', sub: [...meals].join(', ') });
  }
  for (const [xid, x] of Object.entries(S.shop.extras)) items.push({ id: xid, name: x.name, aisle: x.aisle || 'Other', extra: true });
  return items;
}
function groupByAisle(items) {
  const groups = new Map(aisleOrder().map((a) => [a, []]));
  for (const it of items) groups.get(it.aisle)?.push(it) ?? groups.set(it.aisle, [it]);
  for (const list of groups.values()) list.sort(byName);
  return [...groups].filter(([, list]) => list.length);
}

/* ---------------- render ---------------- */
function syncBadge() {
  if (store?.kind === 'demo') return '<span class="sync demo">Demo · this phone only</span>';
  if (!navigator.onLine) return '<span class="sync offline">Offline · saved on phone</span>';
  if (meta.pending) return '<span class="sync pending">Syncing…</span>';
  if (meta.fromCache) return '<span class="sync offline">Saved on phone</span>';
  return '<span class="sync">Synced ✓</span>';
}
const header = (title, sub) => `<header class="top"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${syncBadge()}</header>`;

function render() {
  // Keep focus, typed text and caret across re-renders (e.g. when the other phone syncs a change)
  const a = document.activeElement;
  const keep = a && a.id && app.contains(a) && a.matches('input') ? { id: a.id, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  const sheetScroll = app.querySelector('.sheet')?.scrollTop;

  if (!S) { app.innerHTML = renderNoData(); tabbar.hidden = true; return; }
  const views = { plan: renderPlan, meals: renderMeals, stock: renderStock, shop: renderShop };
  app.innerHTML = (views[ui.tab] || renderPlan)() + renderModal();
  tabbar.hidden = false;
  tabbar.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const left = shoppingItems().filter((i) => !S.shop.got[i.id]).length;
  const badge = document.getElementById('shop-badge');
  badge.hidden = !left; badge.textContent = left;

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { if (keep.id !== 'ing-search') el.value = keep.value; el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.s, keep.e); } catch {} }
  }
  const sheet = app.querySelector('.sheet');
  if (sheet && sheetScroll != null) sheet.scrollTop = sheetScroll;
}

function renderNoData() {
  if (store.kind === 'firebase' && meta.fromCache) {
    return `<div class="splash"><div class="spinner"></div><p><b>Connecting…</b><br>The first time on a phone it needs signal to download your plan.<br>After that it works offline.</p></div>`;
  }
  return `${header('Welcome', '')}
    <div class="card empty">
      <b>Let's get your meal plan in</b>
      I've converted your “3 Week Meal Plan” spreadsheet: 18 meals, 64 ingredients and the 3-week rotation.
      <button class="btn primary" data-action="seed">Import my spreadsheet plan</button>
      <button class="btn ghost" data-action="seed-empty">Start with a blank plan</button>
    </div>`;
}

/* ---- Plan ---- */
function renderPlan() {
  const weeks = weekIds();
  const w = weeks.includes(ui.planWeek) ? ui.planWeek : (ui.planWeek = S.shop.week);
  const wk = S.weeks[w];
  const meals = mealList();
  const opts = (sel) => `<option value="">— Nothing planned —</option>` +
    meals.map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const daily = Object.keys(wk.daily).filter((id) => S.meals[id]);
  return `${header('Meal plan', `${weeks.length}-week rotation · shopping for week ${esc(S.shop.week)}`)}
    <div class="seg">
      ${weeks.map((id) => `<button class="${id === w ? 'on' : ''}" data-action="plan-week" data-week="${id}">Week ${id}${id === S.shop.week ? '<span class="dot" title="Current shop"></span>' : ''}</button>`).join('')}
      <button data-action="add-week" aria-label="Add a week">+ Week</button>
    </div>
    <div class="card">
      ${DAYS.map((d) => `<label class="day ${d === todayName && w === S.shop.week ? 'today' : ''}"><span class="dname">${d}</span>
        <select class="pretty ${wk.days[d] ? '' : 'empty'}" data-action="set-day" data-week="${w}" data-day="${d}">${opts(wk.days[d])}</select></label>`).join('')}
    </div>
    <div class="card">
      <h3>Every day this week</h3>
      <div class="chips">
        ${daily.map((id) => `<button class="chip" data-action="rm-daily" data-week="${w}" data-id="${esc(id)}">${esc(S.meals[id].name)} <span class="x">×</span></button>`).join('')}
        <span class="chip add">+ Add<select data-action="add-daily" data-week="${w}" aria-label="Add an every-day meal"><option value="">Add</option>${meals.filter((m) => !wk.daily[m.id]).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></span>
      </div>
    </div>
    ${w === S.shop.week
      ? `<button class="btn primary" data-action="tab" data-tab="stock">Do the stock check for week ${w} →</button>`
      : `<button class="btn primary" data-action="shop-week" data-week="${w}">Shop for week ${w} next</button>`}
    ${weeks.length > 1 ? `<button class="btn ghost danger" data-action="del-week" data-week="${w}">Delete week ${w}</button>` : ''}`;
}

/* ---- Meals / Ingredients / Settings ---- */
function renderMeals() {
  const tabs = [['meals', 'Meals'], ['ings', 'Ingredients'], ['settings', 'Aisles & settings']];
  const seg = `<div class="seg">${tabs.map(([k, l]) => `<button class="${ui.mealsTab === k ? 'on' : ''}" data-action="meals-tab" data-k="${k}">${l}</button>`).join('')}</div>`;
  if (ui.mealsTab === 'ings') return header('Ingredients', `${Object.keys(S.ingredients).length} ingredients`) + seg + renderIngredients();
  if (ui.mealsTab === 'settings') return header('Settings', 'Aisle order matches your walk round the shop') + seg + renderSettings();
  const meals = mealList();
  return `${header('Meals', `${meals.length} meals`)}${seg}
    <form class="addbar" data-action="add-meal"><input id="new-meal" name="name" placeholder="New meal name" autocomplete="off"><button>Add</button></form>
    <div class="card">
      ${meals.length ? meals.map((m) => {
        const n = Object.keys(m.ings).filter((i) => S.ingredients[i]).length;
        const ws = weeksUsing(m.id);
        return `<button class="row" data-action="open-meal" data-id="${esc(m.id)}"><span class="main"><span class="name">${esc(m.name)}</span>
          <span class="sub">${n} ingredient${n === 1 ? '' : 's'}${ws.length ? ` · week ${ws.join(', ')}` : ' · not planned'}</span></span><span class="chev">›</span></button>`;
      }).join('') : '<div class="empty">No meals yet. Add one above.</div>'}
    </div>`;
}

const aisleSelect = (id, sel, action, extra = '') => `<select class="pretty" id="${id}" ${action ? `data-action="${action}"` : ''} ${extra}>${aisleOrder().map((a) => `<option ${a === sel ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>`;

function renderIngredients() {
  const items = Object.entries(S.ingredients).map(([id, i]) => ({ id, name: i.name, aisle: i.aisle || 'Other' }));
  return `<form class="card formcard" data-action="add-ing">
      <div class="line"><input class="field" id="new-ing" name="name" placeholder="New ingredient" autocomplete="off"></div>
      <div class="line">${aisleSelect('new-ing-aisle', 'Other', '', 'name="aisle"')}<button class="btn primary" style="width:auto;margin:0">Add</button></div>
    </form>
    ${groupByAisle(items).map(([aisle, list]) => `<div class="card"><h3>${esc(aisle)} <span class="count">${list.length}</span></h3>
      ${list.map((i) => `<div class="ing-row"><input class="field" id="ing-name-${esc(i.id)}" data-action="rename-ing" data-id="${esc(i.id)}" value="${esc(i.name)}" aria-label="Name">
        ${aisleSelect(`ing-aisle-${esc(i.id)}`, i.aisle, 'set-aisle', `data-id="${esc(i.id)}" aria-label="Aisle"`)}
        <button class="iconbtn" data-action="del-ing" data-id="${esc(i.id)}" aria-label="Delete ${esc(i.name)}">✕</button></div>`).join('')}
    </div>`).join('')}`;
}

function renderSettings() {
  const order = aisleOrder();
  const used = (a) => Object.values(S.ingredients).filter((i) => (i.aisle || 'Other') === a).length;
  return `<div class="card"><h3>Aisle order</h3>
      ${order.map((a, idx) => `<div class="ing-row"><input class="field" id="aisle-${idx}" data-action="rename-aisle" data-old="${esc(a)}" value="${esc(a)}" aria-label="Aisle name">
        <span class="note">${used(a)}</span>
        <button class="iconbtn" data-action="aisle-up" data-i="${idx}" ${idx === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="iconbtn" data-action="aisle-down" data-i="${idx}" ${idx === order.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="iconbtn" data-action="del-aisle" data-i="${idx}" ${used(a) ? 'disabled' : ''} aria-label="Delete aisle">✕</button></div>`).join('')}
    </div>
    <form class="addbar" data-action="add-aisle"><input id="new-aisle" name="name" placeholder="New aisle (e.g. Frozen)" autocomplete="off"><button>Add</button></form>
    <p class="note" style="margin-bottom:16px">Put aisles in the order you walk round the shop. The shopping list follows this order. An aisle can only be deleted once no ingredients use it.</p>
    <button class="btn secondary" data-action="backup">Download a backup</button>
    ${store.kind === 'firebase'
      ? `<p class="note">Signed in as ${esc(store.auth.currentUser?.email)}</p><button class="btn ghost" data-action="sign-out">Sign out</button>`
      : `<p class="note">Demo mode: everything is saved on this phone only. Once Firebase is set up (see the setup guide), both phones share one plan.</p>
         <button class="btn ghost danger" data-action="reset-demo">Reset demo data</button>`}`;
}

/* ---- Stock check ---- */
function renderStock() {
  const w = S.shop.week;
  const need = neededFor(w);
  const items = [...need].map(([id, meals]) => ({ id, name: S.ingredients[id].name, aisle: S.ingredients[id].aisle || 'Other', sub: [...meals].join(', ') }));
  const have = items.filter((i) => S.shop.stock[i.id]).length;
  const toBuy = shoppingItems().length;
  const weekSel = `<div class="seg">${weekIds().map((id) => `<button class="${id === w ? 'on' : ''}" data-action="shop-week" data-week="${id}">Week ${id}</button>`).join('')}</div>`;
  if (!items.length) {
    return header('Stock check', `Week ${w}`) + weekSel + `<div class="card empty"><b>Nothing planned for week ${w}</b>Add some meals to the plan first.<button class="btn primary" data-action="tab" data-tab="plan">Go to the plan</button></div>`;
  }
  return `${header('Stock check', `Week ${w} · tap anything you've already got`)}
    ${weekSel}
    <div class="stat"><div class="need"><b>${items.length - have}</b><span>to buy</span></div><div class="have"><b>${have}</b><span>in the cupboard</span></div></div>
    ${groupByAisle(items).map(([aisle, list]) => `<div class="card"><h3>${esc(aisle)}</h3>
      ${list.map((i) => { const h = !!S.shop.stock[i.id]; return `<button class="row ${h ? 'have' : ''}" data-action="toggle-stock" data-id="${esc(i.id)}" aria-pressed="${h}">
        <span class="main"><span class="name">${esc(i.name)}</span><span class="sub">${esc(i.sub)}</span></span><span class="pill">${h ? 'Got it' : 'Need'}</span></button>`; }).join('')}
    </div>`).join('')}
    <button class="btn primary" data-action="tab" data-tab="shop">See shopping list (${toBuy}) →</button>
    ${have ? '<button class="btn ghost" data-action="reset-stock">Reset stock check</button>' : ''}`;
}

/* ---- Shopping list ---- */
function renderShop() {
  const items = shoppingItems();
  const got = items.filter((i) => S.shop.got[i.id]).length;
  const pct = items.length ? Math.round((got / items.length) * 100) : 0;
  const visible = ui.hideGot ? items.filter((i) => !S.shop.got[i.id]) : items;
  const names = Object.values(S.ingredients).map((i) => i.name).sort();
  const list = items.length && got === items.length
    ? `<div class="card done-banner"><b>All done 🎉</b><span class="note">Everything's in the trolley.</span></div>`
    : groupByAisle(visible).map(([aisle, list]) => {
        const left = list.filter((i) => !S.shop.got[i.id]).length;
        return `<div class="card"><h3>${esc(aisle)} <span class="count">${left ? `${left} left` : 'done'}</span></h3>
        ${list.map((i) => { const g = !!S.shop.got[i.id]; return `<div class="row item ${g ? 'got' : ''}" data-action="toggle-got" data-id="${esc(i.id)}" role="checkbox" aria-checked="${g}" tabindex="0">
          <span class="tick">${tick}</span><span class="main"><span class="name">${esc(i.name)}${i.extra ? '<span class="extra-tag">extra</span>' : ''}</span>${i.sub ? `<span class="sub">${esc(i.sub)}</span>` : ''}</span>
          ${i.extra ? `<button class="rm" data-action="rm-extra" data-id="${esc(i.id)}" aria-label="Remove ${esc(i.name)}">×</button>` : ''}</div>`; }).join('')}
      </div>`; }).join('');
  return `${header('Shopping list', `Week ${esc(S.shop.week)} · ${items.length} item${items.length === 1 ? '' : 's'}`)}
    <form class="addbar" data-action="add-extra"><input id="new-extra" name="name" list="ing-names" placeholder="Add something else…" autocomplete="off" enterkeyhint="done"><button>Add</button></form>
    <datalist id="ing-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    ${items.length ? `<div class="progress"><i style="width:${pct}%"></i></div>
      <div class="progress-label"><span>${got} of ${items.length} in the trolley</span><button data-action="hide-got">${ui.hideGot ? 'Show ticked' : 'Hide ticked'}</button></div>` : ''}
    ${items.length ? list : `<div class="card empty"><b>Nothing to buy</b>Do the stock check, or add extras above.<button class="btn secondary" data-action="tab" data-tab="stock">Go to stock check</button></div>`}
    ${items.length || Object.keys(S.shop.stock).length ? '<button class="btn secondary" data-action="finish">Finish shop</button>' : ''}`;
}

/* ---- Bottom sheets ---- */
function renderModal() {
  const m = ui.modal; if (!m) { renderModal.last = null; return ''; }
  let body = '';
  if (m.type === 'meal') {
    const meal = S.meals[m.id]; if (!meal) { ui.modal = null; return ''; }
    const sel = Object.keys(meal.ings).filter((i) => S.ingredients[i]).map((id) => ({ id, ...S.ingredients[id] })).sort(byName);
    body = `<div class="sheet-head"><input class="title-input" id="meal-name" data-action="rename-meal" data-id="${esc(m.id)}" value="${esc(meal.name)}" aria-label="Meal name"><button class="done" data-action="close-modal">Done</button></div>
      <div class="chips" style="padding:0 0 12px">${sel.length ? sel.map((i) => `<button class="chip" data-action="toggle-meal-ing" data-id="${esc(i.id)}">${esc(i.name)} <span class="x">×</span></button>`).join('') : '<span class="note">No ingredients yet. Tick some below.</span>'}</div>
      <input type="search" class="search" id="ing-search" placeholder="Find or add an ingredient" autocomplete="off" value="${esc(ui.search)}">
      <div id="ing-picker">${renderPicker(m.id)}</div>
      <button class="btn ghost danger" data-action="del-meal" data-id="${esc(m.id)}">Delete this meal</button>`;
  } else if (m.type === 'confirm') {
    body = `<h2>${esc(m.title)}</h2><p class="lead">${esc(m.text)}</p>
      <button class="btn primary ${m.danger ? 'danger-bg' : ''}" data-action="confirm-ok" ${m.danger ? 'style="background:var(--tomato)"' : ''}>${esc(m.ok)}</button>
      <button class="btn ghost" data-action="close-modal">Cancel</button>`;
  } else if (m.type === 'finish') {
    const weeks = weekIds(); const next = weeks[(weeks.indexOf(S.shop.week) + 1) % weeks.length];
    body = `<h2>Finish this shop?</h2><p class="lead">This clears the ticks, the stock check and any extras, ready for next time.</p>
      <label class="day" style="border:0;padding:0 0 16px"><span class="note" style="flex:none">Next shop is for</span>
      <select class="pretty" id="next-week">${weeks.map((w) => `<option value="${w}" ${w === next ? 'selected' : ''}>Week ${w}</option>`).join('')}</select></label>
      <button class="btn primary" data-action="finish-ok">Finish shop</button>
      <button class="btn ghost" data-action="close-modal">Not yet</button>`;
  }
  const fresh = renderModal.last !== m; renderModal.last = m;   // animate only when first opened
  return `<div class="sheet-back ${fresh ? 'anim' : ''}" data-action="close-modal"></div><div class="sheet ${fresh ? 'anim' : ''} ${m.type === 'meal' ? 'tall' : ''}" role="dialog" aria-modal="true"><div class="grab"></div>${body}</div>`;
}

function renderPicker(mealId) {
  const meal = S.meals[mealId];
  const q = ui.search.trim().toLowerCase();
  const all = Object.entries(S.ingredients).map(([id, i]) => ({ id, name: i.name, aisle: i.aisle || 'Other' }));
  const hits = q ? all.filter((i) => i.name.toLowerCase().includes(q)) : all;
  const exact = all.some((i) => i.name.toLowerCase() === q);
  const add = q && !exact ? `<p class="note" style="margin:4px 4px 6px">${hits.length ? 'Not what you meant?' : 'Not on your list yet.'}</p><div class="card newing"><span class="main" style="flex:1;min-width:0"><b>New: “${esc(ui.search.trim())}”</b></span>
      ${aisleSelect('new-meal-ing-aisle', 'Other', '', 'style="flex:0 0 120px"')}<button data-action="add-ing-to-meal" data-id="${esc(mealId)}">Add</button></div>` : '';
  return groupByAisle(hits).map(([aisle, list]) => `<div class="card"><h3>${esc(aisle)}</h3>
    ${list.map((i) => { const on = !!meal.ings[i.id]; return `<button class="row pick ${on ? 'on' : ''}" data-action="toggle-meal-ing" data-id="${esc(i.id)}" aria-pressed="${on}"><span class="box">${tick}</span><span class="main"><span class="name">${esc(i.name)}</span></span></button>`; }).join('')}
  </div>`).join('') + add;
}

function renderSignIn(msg = '', mode = 'in') {
  tabbar.hidden = true;
  app.innerHTML = `<form class="signin" data-action="${mode === 'up' ? 'sign-up' : 'sign-in'}">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1>Meal Planner</h1>
    <p>${mode === 'up' ? 'Create your account. Use the email address listed in the setup.' : 'Sign in once on each phone. It stays signed in, even offline.'}</p>
    ${mode === 'in' ? `<button type="button" class="btn primary" data-action="google"><svg width="20" height="20" viewBox="0 0 48 48" style="background:#fff;border-radius:50%;padding:2px"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>Continue with Google</button>
    <p class="note" style="margin:6px 0 14px">or use email and password</p>` : ''}
    <input type="email" name="email" placeholder="Email" autocomplete="username" required>
    <input type="password" name="password" placeholder="Password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" minlength="6" required>
    <div class="err">${esc(msg)}</div>
    <button class="btn primary">${mode === 'up' ? 'Create account' : 'Sign in'}</button>
    <button type="button" class="btn ghost" data-action="${mode === 'up' ? 'show-sign-in' : 'show-sign-up'}">${mode === 'up' ? 'I already have an account' : 'First time? Create an account'}</button>
    ${mode === 'in' ? '<button type="button" class="btn ghost" data-action="forgot">Forgot password</button>' : ''}
  </form>`;
}

/* ---------------- actions ---------------- */
function openConfirm(title, text, ok, fn, danger = true) { ui.modal = { type: 'confirm', title, text, ok, danger }; confirmFn = fn; render(); }
function closeModal() { ui.modal = null; ui.search = ''; confirmFn = null; render(); }
function addIngredient(name, aisle) {
  const existing = Object.entries(S.ingredients).find(([, i]) => i.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing[0];
  const id = uniqueId(slug(name), S.ingredients);
  update({ [`ingredients.${id}`]: { name, aisle: aisle || 'Other' } });
  return id;
}

const click = {
  tab(el) { ui.tab = el.dataset.tab; ls.set('mp.tab', ui.tab); ui.modal = null; render(); scrollTo(0, 0); },
  seed() { store.seed(false); },
  'seed-empty'() { store.seed(true); },
  'plan-week'(el) { ui.planWeek = el.dataset.week; render(); },
  'add-week'() {
    const id = String(Math.max(0, ...weekIds().map(Number)) + 1);
    update({ [`weeks.${id}`]: { days: {}, daily: {} } }); ui.planWeek = id; toast(`Week ${id} added`);
  },
  'del-week'(el) {
    const w = el.dataset.week;
    openConfirm(`Delete week ${w}?`, 'Its meals are removed from the plan. The meals themselves are kept.', 'Delete week', () => {
      const ch = { [`weeks.${w}`]: DEL };
      if (S.shop.week === w) ch['shop.week'] = weekIds().find((x) => x !== w);
      ui.planWeek = null; update(ch);
    });
  },
  'rm-daily'(el) { update({ [`weeks.${el.dataset.week}.daily.${el.dataset.id}`]: DEL }); },
  'shop-week'(el) {
    if (el.dataset.week === S.shop.week) return;
    const w = el.dataset.week;
    const go = () => { update({ 'shop.week': w, 'shop.stock': {}, 'shop.got': {} }); ui.planWeek = w; toast(`Shopping for week ${w}`); };
    if (Object.keys(S.shop.stock).length || Object.keys(S.shop.got).length) {
      openConfirm(`Switch to week ${w}?`, 'This clears the current stock check and ticks. Extras you added are kept.', 'Switch week', go, false);
    } else go();
  },
  'meals-tab'(el) { ui.mealsTab = el.dataset.k; render(); },
  'open-meal'(el) { ui.modal = { type: 'meal', id: el.dataset.id }; ui.search = ''; render(); },
  'close-modal'() { closeModal(); },
  'confirm-ok'() { const fn = confirmFn; closeModal(); fn && fn(); },
  'toggle-meal-ing'(el) {
    const mid = ui.modal?.id; if (!mid) return;
    const on = !!S.meals[mid].ings[el.dataset.id];
    const fromSearch = !!ui.search && el.closest('#ing-picker');
    if (fromSearch) ui.search = '';
    update({ [`meals.${mid}.ings.${el.dataset.id}`]: on ? DEL : true });
    if (fromSearch) { render(); if (!on) toast(`${S.ingredients[el.dataset.id]?.name} ticked`); }
  },
  'add-ing-to-meal'(el) {
    const name = ui.search.trim(); if (!name) return;
    const aisle = document.getElementById('new-meal-ing-aisle').value;
    const iid = addIngredient(name, aisle);
    ui.search = '';
    update({ [`meals.${el.dataset.id}.ings.${iid}`]: true });
    toast(`${name} added`);
  },
  'del-meal'(el) {
    const id = el.dataset.id; const name = S.meals[id].name;
    openConfirm(`Delete ${name}?`, 'It will also be removed from any week it is planned in.', 'Delete meal', () => {
      const ch = { [`meals.${id}`]: DEL };
      for (const w of weekIds()) {
        for (const [d, mid] of Object.entries(S.weeks[w].days)) if (mid === id) ch[`weeks.${w}.days.${d}`] = DEL;
        if (S.weeks[w].daily[id]) ch[`weeks.${w}.daily.${id}`] = DEL;
      }
      update(ch);
    });
  },
  'del-ing'(el) {
    const id = el.dataset.id; const ing = S.ingredients[id];
    const usedIn = Object.values(S.meals).filter((m) => m.ings[id]).map((m) => m.name);
    openConfirm(`Delete ${ing.name}?`, usedIn.length ? `It's used in ${usedIn.join(', ')}. It will be removed from those meals.` : 'It is not used in any meals.', 'Delete', () => {
      const ch = { [`ingredients.${id}`]: DEL };
      for (const [mid, m] of Object.entries(S.meals)) if (m.ings[id]) ch[`meals.${mid}.ings.${id}`] = DEL;
      if (S.shop.stock[id]) ch[`shop.stock.${id}`] = DEL;
      if (S.shop.got[id]) ch[`shop.got.${id}`] = DEL;
      update(ch);
    });
  },
  'aisle-up'(el) { moveAisle(+el.dataset.i, -1); },
  'aisle-down'(el) { moveAisle(+el.dataset.i, 1); },
  'del-aisle'(el) { const order = aisleOrder(); order.splice(+el.dataset.i, 1); update({ aisles: order }); },
  'toggle-stock'(el) { const id = el.dataset.id; update({ [`shop.stock.${id}`]: S.shop.stock[id] ? DEL : true }); },
  'reset-stock'() { openConfirm('Reset the stock check?', 'Everything goes back to “Need”.', 'Reset', () => update({ 'shop.stock': {} })); },
  'toggle-got'(el) {
    const id = el.dataset.id;
    navigator.vibrate?.(8);
    update({ [`shop.got.${id}`]: S.shop.got[id] ? DEL : true });
  },
  'rm-extra'(el, e) { e.stopPropagation(); update({ [`shop.extras.${el.dataset.id}`]: DEL, [`shop.got.${el.dataset.id}`]: DEL }); },
  'hide-got'() { ui.hideGot = !ui.hideGot; ls.set('mp.hideGot', ui.hideGot ? '1' : '0'); render(); },
  finish() { ui.modal = { type: 'finish' }; render(); },
  'finish-ok'() {
    const next = document.getElementById('next-week').value;
    closeModal();
    update({ shop: { week: next, stock: {}, got: {}, extras: {} } });
    ui.planWeek = next; toast(`Done! Next shop: week ${next}`);
  },
  backup() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `meal-planner-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'sign-out'() { openConfirm('Sign out?', 'You will need signal to sign back in.', 'Sign out', () => store.signOut(), false); },
  'reset-demo'() { openConfirm('Reset demo data?', 'Puts the plan back to how it was in your spreadsheet.', 'Reset', () => store.seed(false)); },
  'show-sign-up'() { renderSignIn('', 'up'); },
  'show-sign-in'() { renderSignIn('', 'in'); },
  async google() {
    try { await store.google(); } catch (e) { renderSignIn(friendlyAuth(e)); }
  },
  async forgot() {
    const email = app.querySelector('input[name=email]').value.trim();
    if (!email) return renderSignIn('Type your email first, then tap “Forgot password”.');
    try { await store.reset(email); toast('Password reset email sent'); } catch (e) { renderSignIn(friendlyAuth(e)); }
  },
};

function moveAisle(i, dir) {
  const order = aisleOrder(); const j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  update({ aisles: order });
}

const change = {
  'set-day'(el) { update({ [`weeks.${el.dataset.week}.days.${el.dataset.day}`]: el.value || DEL }); },
  'add-daily'(el) { if (el.value) update({ [`weeks.${el.dataset.week}.daily.${el.value}`]: true }); },
  'rename-meal'(el) { const v = el.value.trim(); if (v && v !== S.meals[el.dataset.id]?.name) update({ [`meals.${el.dataset.id}.name`]: v }); },
  'rename-ing'(el) { const v = el.value.trim(); if (v && v !== S.ingredients[el.dataset.id]?.name) update({ [`ingredients.${el.dataset.id}.name`]: v }); else el.value = S.ingredients[el.dataset.id]?.name || ''; },
  'set-aisle'(el) { update({ [`ingredients.${el.dataset.id}.aisle`]: el.value }); },
  'rename-aisle'(el) {
    const from = el.dataset.old, to = el.value.trim();
    if (!to || to === from) { el.value = from; return; }
    const ch = { aisles: aisleOrder().map((a) => (a === from ? to : a)) };
    for (const [id, i] of Object.entries(S.ingredients)) if ((i.aisle || 'Other') === from) ch[`ingredients.${id}.aisle`] = to;
    for (const [id, x] of Object.entries(S.shop.extras)) if ((x.aisle || 'Other') === from) ch[`shop.extras.${id}.aisle`] = to;
    update(ch);
  },
};

const submit = {
  'add-meal'(form) {
    const name = form.name.value.trim(); if (!name) return;
    const id = uniqueId(slug(name), S.meals);
    form.name.value = '';
    update({ [`meals.${id}`]: { name, ings: {} } });
    ui.modal = { type: 'meal', id }; ui.search = ''; render();
  },
  'add-ing'(form) {
    const name = form.name.value.trim(); if (!name) return;
    if (Object.values(S.ingredients).some((i) => i.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already on the list`);
    form.name.value = '';
    addIngredient(name, form.aisle.value); toast(`${name} added`);
  },
  'add-aisle'(form) {
    const name = form.name.value.trim(); if (!name) return;
    if (aisleOrder().includes(name)) return toast('That aisle already exists');
    form.name.value = '';
    update({ aisles: [...aisleOrder(), name] });
  },
  'add-extra'(form) {
    const name = form.name.value.trim(); if (!name) return;
    const known = Object.values(S.ingredients).find((i) => i.name.toLowerCase() === name.toLowerCase());
    form.name.value = '';
    update({ [`shop.extras.x${rid()}`]: { name: known ? known.name : name, aisle: known ? known.aisle || 'Other' : 'Other' } });
  },
  async 'sign-in'(form) {
    try { await store.signIn(form.email.value.trim(), form.password.value); } catch (e) { renderSignIn(friendlyAuth(e)); }
  },
  async 'sign-up'(form) {
    try { await store.signUp(form.email.value.trim(), form.password.value); } catch (e) { renderSignIn(friendlyAuth(e), 'up'); }
  },
};

function friendlyAuth(e) {
  const c = e?.code || '';
  if (c.includes('popup-blocked') || c.includes('operation-not-supported')) return 'This browser blocked the Google sign-in window. Open the link in Safari or Chrome itself (not inside another app), or use email and password.';
  if (c.includes('popup-closed') || c.includes('cancelled')) return 'Google sign-in was cancelled.';
  if (c.includes('unauthorized-domain')) return 'This web address needs adding to Firebase’s authorised domains (setup step 3.5).';
  if (c.includes('network')) return 'No signal. Signing in needs the internet the first time.';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'Email or password not recognised.';
  if (c.includes('email-already-in-use')) return 'That email already has an account. Sign in instead.';
  if (c.includes('weak-password')) return 'Password needs at least 6 characters.';
  return e?.message || 'Something went wrong.';
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'FORM') return;
  const fn = click[el.dataset.action]; if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=checkbox][data-action]')) { e.preventDefault(); click[e.target.dataset.action]?.(e.target, e); }
});
document.addEventListener('change', (e) => {
  const el = e.target; const fn = el.dataset?.action && change[el.dataset.action]; if (fn) fn(el);
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-action]'); if (!form) return;
  e.preventDefault(); submit[form.dataset.action]?.(form);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'ing-search') {
    ui.search = e.target.value;
    const box = document.getElementById('ing-picker');
    if (box && ui.modal?.type === 'meal') box.innerHTML = renderPicker(ui.modal.id);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[data-action^="rename"]')) e.target.blur();
  if (e.key === 'Escape' && ui.modal) closeModal();
  if (e.key === 'Enter' && e.target.id === 'ing-search' && ui.modal?.type === 'meal') {
    e.preventDefault();
    const rows = document.querySelectorAll('#ing-picker [data-action=toggle-meal-ing]');
    if (rows.length === 1) click['toggle-meal-ing'](rows[0]);
    else if (!rows.length && ui.search.trim()) click['add-ing-to-meal'](document.querySelector('[data-action=add-ing-to-meal]'));
  }
});
addEventListener('online', () => S && render());
addEventListener('offline', () => S && render());

/* ---------------- boot ---------------- */
function startData() {
  unsub?.();
  unsub = store.start((data, m) => { meta = m; S = data ? normalize(data) : null; render(); },
    (err) => { app.innerHTML = `<div class="card empty"><b>Can't open the plan</b>${esc(err.code === 'permission-denied' ? 'This account isn\'t on the allowed list. Check the email addresses in your Firestore rules.' : err.message)}<button class="btn secondary" data-action="sign-out-now">Sign out</button></div>`; });
}
click['sign-out-now'] = () => store.signOut();

async function boot() {
  const params = new URLSearchParams(location.search);
  if (!firebaseConfig || params.has('demo')) { store = demoStore(); startData(); return; }
  try { store = await firebaseStore(); }
  catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card empty"><b>Couldn't start</b>The app needs signal the very first time it opens on a phone, to download what it needs for offline use. Try again with signal.<button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  store.onAuth((user) => {
    if (user) startData();
    else { unsub?.(); unsub = null; S = null; renderSignIn(); }
  });
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();

(() => {
'use strict';
const root = document.getElementById('lm');
const screen = root.querySelector('#lm-screen');
const nav = root.querySelector('nav');

// ---------------- helpers ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => (x === null || x === undefined ? '—' : Math.round(x).toLocaleString('ru-RU'));
const short = (x) => (x === null || x === undefined ? '—' : x >= 1e6 ? (x / 1e6).toFixed(1).replace('.', ',') + ' млн' : x >= 1000 ? (x / 1000).toFixed(1).replace('.', ',') + 'к' : n(x));
const pct = (x, d = 1) => (x === null || x === undefined ? '—' : x.toFixed(d).replace('.', ',') + '%');
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const button = (text, attr, cl = '') => `<button type="button" class="cursor-interaction ${cl}" ${attr}>${text}</button>`;
const row = (label, val, sub = '') => `<div class="line"><span>${label}</span><span><b>${val}</b>${sub ? ` <small>${sub}</small>` : ''}</span></div>`;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pad = (x) => String(x).padStart(2, '0');
const localDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const todayStr = () => localDate(Date.now());
const asDate = (s) => new Date(s + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const shiftDate = (s, k) => iso(new Date(asDate(s).getTime() + k * 86400000));
const dateLabel = (s) => asDate(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLong = (s) => `${+s.slice(8)} ${MONTHS_GEN[+s.slice(5, 7) - 1]}`;
const timeOf = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const ago = (ts) => {
  if (!ts) return '—';
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  if (m < 60 * 24) return `${Math.round(m / 60)} ч назад`;
  return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const median = (arr) => { const a = arr.filter((v) => v !== null && v !== undefined).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const sum = (arr) => arr.reduce((a, v) => a + (v ?? 0), 0);
const sumN = (arr) => (arr.some((v) => v !== null && v !== undefined) ? sum(arr) : null);
const mediaSrc = (u) => (!u ? '' : u.startsWith('/') ? u : '/api/media?u=' + encodeURIComponent(u));
function drawIcons() { if (window.lucide) lucide.createIcons({ icons: lucide.icons, attrs: { width: 20, height: 20 } }); }

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(json?.error || 'Ошибка сервера'); e.status = res.status; throw e; }
  return json;
}

let toastTimer;
function toast(msg) {
  root.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  root.appendChild(t);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3500);
}

// ---------------- state ----------------
const S = {
  stage: 'boot', // boot | email | code | instagram | loading | app
  me: null, email: '', devCode: null, authError: '',
  data: null, posts: [], byId: new Map(),
  page: 'overview', mode: 'grid', format: 'Все', query: '', selected: null, month: null, topMetric: 'likes',
};
const SERIES_PUBLIC = [
  { key: 'followers', label: 'Подписчики', note: 'на конец интервала' },
  { key: 'views', label: 'Просмотры Reels / видео' },
  { key: 'likes', label: 'Лайки' },
  { key: 'comments', label: 'Комментарии' },
  { key: 'publications', label: 'Публикации' },
  { key: 'er', label: 'ER, %', right: true },
];
const SERIES_FULL = [
  { key: 'reach', label: 'Охват аккаунта' },
  { key: 'views', label: 'Просмотры постов' },
  { key: 'storyViews', label: 'Просмотры Stories' },
  { key: 'followers', label: 'Подписчики', note: 'на конец интервала' },
  { key: 'newFollowers', label: 'Новые подписчики' },
  { key: 'likes', label: 'Лайки' },
  { key: 'saved', label: 'Сохранения' },
  { key: 'shares', label: 'Репосты' },
  { key: 'comments', label: 'Комментарии' },
  { key: 'er', label: 'ER по охвату, %', right: true },
];
let SERIES = SERIES_PUBLIC;
const isFull = () => S.data?.source === 'instagram';
const C = { enabled: new Set(['views', 'likes', 'comments', 'er']), scale: 'absolute', preset: 'month', step: 'day', start: null, end: null, idx: 1, rows: [], observer: null };
let pollTimer = null;

// ---------------- data prep ----------------
function firstSentence(text) {
  const line = (text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const m = line.match(/^(.{1,140}?[.!?…])(\s|$)/);
  return (m ? m[1] : line).slice(0, 140);
}
function lastLine(text) {
  const lines = (text || '').split('\n').map((s) => s.trim()).filter((s) => s && !/^#/.test(s));
  return lines.length > 1 ? lines.at(-1).slice(0, 200) : '';
}
function prepare(data) {
  const sourceChanged = S.data && (S.data.source !== data.source || S.data.profile?.username !== data.profile?.username);
  S.data = data;
  const full = data.source === 'instagram';
  if (sourceChanged || SERIES !== (full ? SERIES_FULL : SERIES_PUBLIC)) {
    SERIES = full ? SERIES_FULL : SERIES_PUBLIC;
    C.enabled = new Set(full ? ['reach', 'views', 'saved', 'er'] : ['views', 'likes', 'comments', 'er']);
    if (S.topMetric && !['likes', 'views', 'comments', 'er', ...(full ? ['reach', 'saved', 'shares'] : [])].includes(S.topMetric)) S.topMetric = 'likes';
  }
  if (sourceChanged) { S.month = null; S.selected = null; }
  const followers = data.profile?.followers || null;
  S.stories = (data.stories || []).map((st) => ({ ...st, date: localDate(st.timestamp) })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  S.storyDays = new Map();
  S.stories.forEach((st) => { if (!S.storyDays.has(st.date)) S.storyDays.set(st.date, []); S.storyDays.get(st.date).push(st); });
  S.posts = (data.posts || []).map((p) => {
    const a = data.annotations?.[p.id] || {};
    const title = firstSentence(p.caption) || `${p.format} без подписи`;
    const er = full
      ? (p.reach ? (((p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0)) / p.reach) * 100 : null)
      : (followers && p.likes !== null ? ((p.likes + (p.comments || 0)) / followers) * 100 : null);
    return { ...p, date: localDate(p.timestamp), title, er, topic: a.topic ?? (p.hashtags?.[0] ? '#' + p.hashtags[0] : ''), hook: a.hook ?? firstSentence(p.caption), cta: a.cta ?? lastLine(p.caption) };
  });
  S.byId = new Map(S.posts.map((p) => [p.id, p]));
  if (!C.start) setPreset('month');
  if (!S.month) {
    const cur = todayStr().slice(0, 7);
    S.month = S.posts.some((p) => p.date.startsWith(cur)) || !S.posts.length ? cur : S.posts[0].date.slice(0, 7);
  }
}
function availableRange() {
  const dates = S.posts.map((p) => p.date).concat((S.data?.snapshots || []).map((s) => s.date), Object.keys(S.data?.daily || {}), (S.stories || []).map((x) => x.date)).sort();
  return { start: dates[0] || todayStr(), end: todayStr() };
}

// ---------------- boot / auth ----------------
async function boot() {
  try {
    S.me = await api('/api/me');
    if (!S.me.source) { S.stage = 'instagram'; return render(); }
    await loadData();
  } catch (e) {
    S.stage = 'email'; render();
  }
}
async function loadData() {
  const data = await api('/api/data');
  const running = data.sync?.status === 'running';
  if (!data.profile) {
    S.data = data; S.stage = 'loading'; render();
    if (running) schedulePoll();
    return;
  }
  const wasRunning = S.data?.sync?.status === 'running';
  prepare(data);
  S.stage = 'app';
  render();
  if (running) schedulePoll();
  else if (wasRunning && data.sync.status === 'ok') toast('Данные обновлены');
  else if (wasRunning && data.sync.status === 'error') toast(data.sync.error);
}
function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(() => loadData().catch(() => schedulePoll()), 4000); }

function normalizeInstagram(input) {
  const text = input.trim();
  let handle = text.replace(/^@/, '');
  if (/^(https?:\/\/|www\.|instagram\.com\/)/i.test(text)) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch { return null; }
    if (!['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    handle = parts[0];
  }
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle) || ['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct'].includes(handle.toLowerCase())) return null;
  return handle.toLowerCase();
}
const authFrame = (body) => `<div class="auth-shell">${body}<div class="auth-bottom"><span>content lens</span><span>Данные: Instagram через Apify</span></div></div>`;

function renderAuth() {
  root.dataset.page = 'auth';
  screen.scrollTop = 0;
  if (S.stage === 'boot') { screen.innerHTML = '<div class="loading"><div class="spinner"></div></div>'; return; }
  if (S.stage === 'email') {
    screen.innerHTML = authFrame(`<div class="auth-progress"><span class="current"></span><span></span></div><div class="auth-intro"><div class="auth-mark">${icon('chart-no-axes-combined')}</div><p class="auth-eyebrow">ВАШ КОНТЕНТ. ВАШИ РЕЗУЛЬТАТЫ.</p><h1>Всё об Instagram.<br>В одном месте.</h1><p>Публикации, вовлечённость и рост аудитории — в одном календаре.</p></div><form id="lm-auth-email"><h2>Войти или создать аккаунт</h2><label for="lm-email">Email</label><input id="lm-email" type="email" autocomplete="email" placeholder="you@example.com" required maxlength="254"><p class="auth-error" role="alert">${esc(S.authError)}</p><button type="submit" class="auth-primary cursor-interaction">Продолжить ${icon('arrow-right')}</button><p class="auth-hint">Вход по коду, без пароля.</p></form>`);
    const input = root.querySelector('#lm-email'); input.value = S.email;
    root.querySelector('#lm-auth-email').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      S.email = input.value.trim();
      try {
        const r = await api('/api/auth/request', { method: 'POST', body: { email: S.email } });
        S.devCode = r.devCode || null; S.authError = ''; S.stage = 'code'; render();
      } catch (err) { S.authError = err.message; render(); }
    };
  } else if (S.stage === 'code') {
    screen.innerHTML = authFrame(`<button id="lm-auth-back" class="auth-back cursor-interaction">${icon('arrow-left')} Назад</button><div class="auth-intro"><div class="auth-mark">${icon('mail')}</div><h1>Подтвердите email</h1><p>${S.devCode ? 'Почта не настроена — код показан ниже' : 'Мы отправили код на'} ${esc(S.email)}</p></div>${S.devCode ? `<div class="demo-code"><span>Код входа (тестовый режим)</span><b>${esc(S.devCode)}</b></div>` : ''}<form id="lm-auth-code"><label for="lm-code">Код из 6 цифр</label><input id="lm-code" class="otp-field" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required><p id="lm-code-error" class="auth-error" role="alert">${esc(S.authError)}</p><button type="submit" class="auth-primary cursor-interaction">Войти ${icon('arrow-right')}</button></form><button id="lm-resend" class="auth-link cursor-interaction">Получить код ещё раз</button><p id="lm-code-status" class="auth-hint" aria-live="polite"></p>`);
    root.querySelector('#lm-auth-back').onclick = () => { S.stage = 'email'; S.authError = ''; render(); };
    root.querySelector('#lm-code').focus();
    root.querySelector('#lm-auth-code').onsubmit = async (e) => {
      e.preventDefault();
      try {
        S.me = await api('/api/auth/verify', { method: 'POST', body: { email: S.email, code: root.querySelector('#lm-code').value.trim() } });
        S.authError = ''; S.devCode = null;
        if (S.me.handle) await loadData(); else { S.stage = 'instagram'; render(); }
      } catch (err) { root.querySelector('#lm-code-error').textContent = err.message; }
    };
    root.querySelector('#lm-resend').onclick = async () => {
      const st = root.querySelector('#lm-code-status');
      try {
        const r = await api('/api/auth/request', { method: 'POST', body: { email: S.email } });
        S.devCode = r.devCode || null;
        if (S.devCode) { render(); } else st.textContent = 'Новый код отправлен.';
      } catch (err) { st.textContent = err.message; }
    };
  } else if (S.stage === 'instagram') {
    screen.innerHTML = authFrame(`<div class="auth-progress"><span class="done"></span><span class="current"></span></div><div class="auth-intro"><div class="auth-mark instagram-mark">${icon('instagram')}</div><p class="auth-eyebrow">НАСТРОЙКА АККАУНТА</p><h1>Какой Instagram<br>будем анализировать?</h1><p>Введите ник или вставьте ссылку на открытый профиль.</p></div><form id="lm-auth-instagram"><label for="lm-instagram">Instagram</label><input id="lm-instagram" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="@username или instagram.com/username" required><p id="lm-instagram-error" class="auth-error" role="alert"></p><div id="lm-account-preview" class="account-preview" hidden><div class="account-initial">@</div><div><b id="lm-preview-name"></b><span>Профиль для анализа</span></div>${icon('check')}</div><button type="submit" class="auth-primary cursor-interaction">Собрать данные ${icon('arrow-right')}</button></form><div class="auth-checklist"><div>${icon('calendar-days')}<span>Публикации по дням: просмотры, лайки, комментарии, ER</span></div><div>${icon('chart-no-axes-combined')}<span>Динамика подписчиков — копится с каждым обновлением</span></div></div><p class="auth-disclaimer">Данные собираются из открытого профиля через Apify. Первый сбор занимает 1–3 минуты. Закрытые профили и Stories недоступны.</p><div class="auth-divider"></div>${button(`Клиенты с полным доступом ${icon('arrow-right')}`, 'id="lm-open-clients"', 'auth-secondary')}<p class="auth-hint">Клиент сам подключает свой Instagram по ссылке — откроются охват, сохранения, репосты и Stories.</p><button id="lm-change-login" class="auth-link cursor-interaction">Войти с другим email</button>`);
    root.querySelector('#lm-open-clients').onclick = () => { S.stage = 'clients'; render(); };
    const input = root.querySelector('#lm-instagram');
    if (S.me?.handle) input.value = '@' + S.me.handle;
    const preview = () => { const h = normalizeInstagram(input.value); root.querySelector('#lm-account-preview').hidden = !h; root.querySelector('#lm-preview-name').textContent = h ? '@' + h : ''; root.querySelector('#lm-instagram-error').textContent = ''; };
    input.oninput = preview; preview();
    root.querySelector('#lm-auth-instagram').onsubmit = async (e) => {
      e.preventDefault();
      const h = normalizeInstagram(input.value);
      if (!h) { root.querySelector('#lm-instagram-error').textContent = 'Укажите ник или ссылку на профиль Instagram, не на публикацию.'; return; }
      try {
        S.me = await api('/api/account', { method: 'POST', body: { handle: h } });
        S.data = null; S.month = null; C.start = null; S.page = 'overview'; S.selected = null;
        await loadData();
      } catch (err) { root.querySelector('#lm-instagram-error').textContent = err.message; }
    };
    root.querySelector('#lm-change-login').onclick = logout;
  } else if (S.stage === 'clients') {
    screen.innerHTML = authFrame(`${button(icon('arrow-left') + ' Назад', 'id="lm-clients-back"', 'auth-back')}<div class="auth-intro"><div class="auth-mark">${icon('users')}</div><h1>Клиенты</h1><p>Подключённые аккаунты и ссылки-приглашения.</p></div><div id="lm-clients"><div class="spinner"></div></div>`);
    root.querySelector('#lm-clients-back').onclick = () => { S.stage = S.me?.source ? 'app' : 'instagram'; if (S.stage === 'app') loadData(); else render(); };
    loadClients();
  } else if (S.stage === 'loading') {
    const sync = S.data?.sync || {};
    const failed = sync.status === 'error';
    screen.innerHTML = `<div class="loading">${failed ? `<div class="auth-mark">${icon('triangle-alert')}</div><h1>Не получилось собрать данные</h1><div class="err-box">${esc(sync.error)}</div>${button('Повторить ' + icon('refresh-cw'), 'id="lm-retry"', 'auth-primary')}` : `<div class="spinner" aria-hidden="true"></div><h1>Собираем ${S.data?.source === 'instagram' ? 'данные клиента' : '@' + esc(S.me?.handle)}</h1><p>${S.data?.source === 'instagram' ? 'Instagram отдаёт публикации, охват и Stories.' : 'Apify читает профиль и публикации за последние месяцы.'} Обычно это 1–3 минуты — страницу можно не закрывать, она обновится сама.</p>`}${button('Другой Instagram', 'id="lm-edit-account"', 'auth-link')}</div>`;
  }
  drawIcons();
}
async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  clearTimeout(pollTimer);
  Object.assign(S, { stage: 'email', me: null, data: null, posts: [], email: '', devCode: null, authError: '', selected: null, month: null, page: 'overview' });
  C.start = null;
  render();
}

// ---------------- app shell ----------------
function render() {
  if (C.observer) { C.observer.disconnect(); C.observer = null; }
  root.querySelector('#lm-handle').textContent = S.stage === 'app' && S.data?.profile?.username ? '@' + S.data.profile.username : '';
  if (S.stage !== 'app') { nav.innerHTML = ''; renderAuth(); return; }
  root.dataset.page = S.selected ? 'post' : S.page;
  nav.innerHTML = [['overview', 'chart-no-axes-combined', 'Обзор'], ['content', 'grid-3x3', 'Контент'], ['more', 'menu', 'Ещё']]
    .map(([p, i, t]) => button(icon(i) + t, `data-page="${p}" aria-current="${S.page === p ? 'page' : 'false'}"`, S.page === p && !S.selected ? 'active' : '')).join('');
  const banner = syncBanner();
  if (S.selected) renderPost(banner);
  else if (S.page === 'content') renderContent(banner);
  else if (S.page === 'overview') renderOverview(banner);
  else renderSettings(banner);
  drawIcons();
}
function syncBanner() {
  const s = S.data?.sync || {};
  const via = isFull() ? 'Instagram' : 'Apify';
  const mock = S.data?.mock ? `<div class="banner"><span>Тестовые данные — ${via} не вызывается</span></div>` : '';
  const expired = isFull() && S.data.status === 'expired' ? `<div class="banner" role="alert"><span>Доступ клиента истёк — отправьте ему ссылку-приглашение ещё раз</span></div>` : '';
  if (s.status === 'running') return mock + expired + `<div class="banner" role="status"><span>Обновляем данные через ${via}…</span></div>`;
  if (s.status === 'error') return mock + expired + `<div class="banner" role="alert"><span>Последнее обновление не удалось: ${esc(s.error)}</span>${button('Повторить', 'data-sync')}</div>`;
  return mock + expired;
}

// ---------------- overview ----------------
function setPreset(p) {
  const t = todayStr();
  C.preset = p;
  if (p === 'week') { C.start = shiftDate(t, -6); C.end = t; C.step = 'day'; }
  if (p === 'month') { C.start = shiftDate(t, -29); C.end = t; C.step = 'day'; }
  if (p === 'quarter') { C.start = shiftDate(t, -90); C.end = t; C.step = 'week'; }
  C.idx = 1;
}
function dayRows(start, end) {
  const snaps = new Map((S.data.snapshots || []).map((s) => [s.date, s.followers]));
  const byDate = new Map();
  S.posts.forEach((p) => { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p); });
  const rows = [];
  for (let d = start; d <= end; d = shiftDate(d, 1)) {
    const ps = byDate.get(d) || [];
    const ers = ps.map((p) => p.er).filter((v) => v !== null);
    const daily = S.data.daily?.[d] || {};
    const sts = S.storyDays?.get(d) || [];
    rows.push({ date: d, posts: ps, followers: snaps.get(d) ?? null, views: sum(ps.map((p) => p.views)), likes: sum(ps.map((p) => p.likes)), comments: sum(ps.map((p) => p.comments)), publications: ps.length, erSum: sum(ers), erN: ers.length,
      saved: sum(ps.map((p) => p.saved)), shares: sum(ps.map((p) => p.shares)), reach: daily.reach ?? null, newFollowers: daily.newFollowers ?? null, storyViews: sts.length ? sum(sts.map((x) => x.views)) : 0 });
  }
  return rows;
}
function prepareChartRows() {
  const groups = new Map();
  dayRows(C.start, C.end).forEach((r) => {
    let key = r.date;
    if (C.step === 'month') key = r.date.slice(0, 7);
    if (C.step === 'week') { const dow = asDate(r.date).getUTCDay(); key = shiftDate(r.date, -((dow + 6) % 7)); }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  C.rows = [...groups.values()].map((items, i) => {
    const first = items[0], last = items.at(-1);
    const fol = items.map((r) => r.followers).filter((v) => v !== null);
    const erN = sum(items.map((r) => r.erN));
    return {
      i: i + 1, start: first.date, end: last.date,
      label: first.date === last.date ? dateLabel(first.date) : dateLabel(first.date) + ' — ' + dateLabel(last.date),
      tick: C.step === 'month' ? asDate(first.date).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' }) : first.date.slice(8) + '.' + first.date.slice(5, 7),
      followers: fol.length ? fol.at(-1) : null,
      views: sum(items.map((r) => r.views)), likes: sum(items.map((r) => r.likes)), comments: sum(items.map((r) => r.comments)),
      publications: sum(items.map((r) => r.publications)), er: erN ? sum(items.map((r) => r.erSum)) / erN : null,
      saved: sum(items.map((r) => r.saved)), shares: sum(items.map((r) => r.shares)), storyViews: sum(items.map((r) => r.storyViews)),
      reach: sumN(items.map((r) => r.reach)), newFollowers: sumN(items.map((r) => r.newFollowers)),
    };
  });
  C.idx = Math.min(Math.max(1, C.idx), C.rows.length);
}
function periodStats(start, end) {
  const ps = S.posts.filter((p) => p.date >= start && p.date <= end);
  const snaps = (S.data.snapshots || []).filter((s) => s.date >= start && s.date <= end);
  const ers = ps.map((p) => p.er).filter((v) => v !== null);
  return {
    posts: ps, publications: ps.length, views: sum(ps.map((p) => p.views)), likes: sum(ps.map((p) => p.likes)), comments: sum(ps.map((p) => p.comments)),
    er: ers.length ? sum(ers) / ers.length : null,
    saved: sum(ps.map((p) => p.saved)), shares: sum(ps.map((p) => p.shares)),
    reach: sumN(Object.entries(S.data.daily || {}).filter(([d]) => d >= start && d <= end).map(([, v]) => v.reach)),
    newFollowers: sumN(Object.entries(S.data.daily || {}).filter(([d]) => d >= start && d <= end).map(([, v]) => v.newFollowers)),
    storyViews: sum((S.stories || []).filter((x) => x.date >= start && x.date <= end).map((x) => x.views)),
    storyFrames: (S.stories || []).filter((x) => x.date >= start && x.date <= end).length,
    dailyDays: Object.keys(S.data.daily || {}).filter((d) => d >= start && d <= end).length,
    storyHistory: (S.stories || []).some((x) => x.date <= start),
    followersEnd: snaps.length ? snaps.at(-1).followers : null,
    followersDelta: snaps.length > 1 ? snaps.at(-1).followers - snaps[0].followers : null,
  };
}
function change(cur, prev) {
  if (cur === null || prev === null || prev === undefined) return '<td>—</td>';
  if (!prev) return cur ? '<td class="positive">новое</td>' : '<td>—</td>';
  const v = ((cur - prev) / prev) * 100;
  return `<td class="${v >= 0 ? 'positive' : 'negative'}">${v >= 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}%</td>`;
}
function moveRange(dir) {
  const av = availableRange();
  let a, b;
  const len = Math.round((asDate(C.end) - asDate(C.start)) / 86400000) + 1;
  a = shiftDate(C.start, dir * len); b = shiftDate(C.end, dir * len);
  return { a, b, valid: a <= av.end && b >= av.start && (dir < 0 || C.end < av.end) };
}
function controlsMarkup() {
  const av = availableRange();
  return `<div class="period-presets" aria-label="Период">${[['week', '7 дней'], ['month', '30 дней'], ['quarter', '90 дней'], ['custom', 'Даты']].map(([k, l]) => `<button class="cursor-interaction" data-period="${k}" aria-pressed="${C.preset === k}">${l}</button>`).join('')}</div>
  <div class="period-nav"><button class="cursor-interaction" id="lm-period-prev" aria-label="Предыдущий период">${icon('chevron-left')}</button><span>${dateLabel(C.start)} — ${dateLabel(C.end)} ${C.end.slice(0, 4)}</span><button class="cursor-interaction" id="lm-period-next" aria-label="Следующий период">${icon('chevron-right')}</button></div>
  ${C.preset === 'custom' ? `<div class="custom-range"><label>С<input id="lm-date-from" type="date" min="${av.start}" max="${av.end}" value="${C.start}"></label><label>По<input id="lm-date-to" type="date" min="${av.start}" max="${av.end}" value="${C.end}"></label><button id="lm-range-apply" class="cursor-interaction">Применить</button><span id="lm-range-error" role="alert"></span></div>` : ''}`;
}
function renderOverview(banner) {
  prepareChartRows();
  const pr = S.data.profile;
  const cur = periodStats(C.start, C.end);
  const len = Math.round((asDate(C.end) - asDate(C.start)) / 86400000) + 1;
  const prev = periodStats(shiftDate(C.start, -len), shiftDate(C.start, -1));
  const kpi = [
    ['Публикации', n(cur.publications), change(cur.publications, prev.publications)],
    ['Просмотры Reels / видео', n(cur.views), change(cur.views, prev.views)],
    ['Лайки', n(cur.likes), change(cur.likes, prev.likes)],
    ['Комментарии', n(cur.comments), change(cur.comments, prev.comments)],
    ['Средний ER', pct(cur.er, 2), cur.er !== null && prev.er !== null ? `<td class="${cur.er >= prev.er ? 'positive' : 'negative'}">${cur.er >= prev.er ? '+' : ''}${(cur.er - prev.er).toFixed(2).replace('.', ',')} п.п.</td>` : '<td>—</td>'],
    ['Подписчики', n(cur.followersEnd ?? pr.followers), cur.followersDelta !== null ? `<td class="${cur.followersDelta >= 0 ? 'positive' : 'negative'}">${cur.followersDelta >= 0 ? '+' : ''}${n(cur.followersDelta)}</td>` : '<td>—</td>'],
  ];
  if (isFull()) {
    kpi[1][0] = 'Просмотры публикаций';
    kpi[4][0] = 'Средний ER по охвату';
    // compare only when the previous period is covered by data too (daily stats exist from connection minus 30 days)
    const fair = (a, b) => (prev.dailyDays >= cur.dailyDays * 0.9 && cur.dailyDays ? change(a, b) : '<td>—</td>');
    kpi.splice(1, 0, ['Охват аккаунта', n(cur.reach), fair(cur.reach, prev.reach)]);
    kpi.splice(5, 0, ['Сохранения', n(cur.saved), change(cur.saved, prev.saved)], ['Репосты', n(cur.shares), change(cur.shares, prev.shares)], ['Stories: кадров / просмотров', `${n(cur.storyFrames)} / ${short(cur.storyViews)}`, prev.storyHistory || prev.storyFrames ? change(cur.storyViews, prev.storyViews) : '<td>—</td>']);
    kpi.push(['Новые подписчики', n(cur.newFollowers), fair(cur.newFollowers, prev.newFollowers)]);
  }
  const metricLabels = isFull() ? { reach: 'охват', views: 'просмотры', saved: 'сохранения', shares: 'репосты', likes: 'лайки', comments: 'комментарии', er: 'ER' } : { likes: 'лайки', views: 'просмотры', comments: 'комментарии', er: 'ER' };
  if (!metricLabels[S.topMetric]) S.topMetric = Object.keys(metricLabels)[0];
  const top = [...cur.posts].filter((p) => p[S.topMetric] !== null).sort((a, b) => b[S.topMetric] - a[S.topMetric]).slice(0, 5);
  const formats = [...new Set(cur.posts.map((p) => p.format))];
  screen.innerHTML = `${banner}<div class="pad">
  <h1>Обзор</h1><p class="sub">@${esc(pr.username)} · обновлено ${ago(S.data.sync?.lastSuccessAt || S.data.sync?.finishedAt)}</p>
  <section class="ov-profile"><div class="ov-avatar">${pr.avatar ? `<img src="${esc(mediaSrc(pr.avatar))}" alt="" onerror="this.remove()">` : esc((pr.username || '?')[0])}</div><div class="stats"><div><b>${short(pr.postsCount)}</b><small>публикаций</small></div><div><b>${short(pr.followers)}</b><small>подписчиков</small></div><div><b>${short(pr.following)}</b><small>подписок</small></div></div></section>
  <p class="ov-bio"><b>${esc(pr.fullName || pr.username)}</b>${pr.category ? ` <span>· ${esc(pr.category)}</span>` : ''}${pr.biography ? '<br>' + esc(pr.biography) : ''}</p>
  ${controlsMarkup()}
  <table class="kpi" aria-label="Показатели за период"><thead><tr><th>Показатель</th><th>За период</th><th>К прошлому</th></tr></thead><tbody>${kpi.map((r) => `<tr><td>${r[0]}</td><td><b>${r[1]}</b></td>${r[2]}</tr>`).join('')}</tbody></table>
  <div class="scale-label">Масштаб по времени</div><div class="time-step" aria-label="Масштаб по времени">${[['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']].map(([k, l]) => `<button class="cursor-interaction" data-step="${k}" aria-pressed="${C.step === k}">${l}</button>`).join('')}</div>
  <div class="chart-controls"><b style="font-size:13px">Шкала значений</b><select id="lm-chart-scale" aria-label="Шкала графика"><option value="absolute">Количество</option><option value="relative">Сравнить динамику, %</option></select></div>
  <p class="legend-hint">Нажмите на название, чтобы скрыть или показать линию</p>
  <div class="chart-legend" aria-label="Выбор линий графика">${SERIES.map((s, i) => `<button class="cursor-interaction" data-series="${s.key}" aria-pressed="${C.enabled.has(s.key)}"><span class="swatch" style="--series:var(--s${i});${i > 3 ? 'border-top-style:dashed' : ''}"></span>${s.label}</button>`).join('')}</div>
  <div class="plot"><svg class="daily-chart" role="img" aria-label="Линейный график показателей за выбранный период"></svg><div class="chart-tip" id="lm-chart-tip" hidden></div></div>
  <div class="chart-help" id="lm-scale-help"></div>
  <div class="day-picker"><label for="lm-chart-day" id="lm-day-title"></label><input id="lm-chart-day" type="range" min="1" max="${C.rows.length}" step="1" value="${C.idx}" aria-label="Выбрать точку графика"></div>
  <details class="chart-table-toggle"><summary class="cursor-interaction"><span class="open-table">Развернуть таблицу</span><span class="close-table">Свернуть таблицу</span></summary><table class="day-table"><thead><tr><th>Показатель</th><th>Значение</th></tr></thead><tbody id="lm-day-values"></tbody></table></details>
  <div class="sectionbar top-head"><h2>Топ публикаций</h2><select id="lm-top-metric" aria-label="Сортировать топ">${Object.entries(metricLabels).map(([k, l]) => `<option value="${k}" ${S.topMetric === k ? 'selected' : ''}>По: ${l}</option>`).join('')}</select></div>
  ${top.length ? top.map((p) => listItem(p, S.topMetric)).join('') : '<p class="empty">За период нет публикаций с этим показателем</p>'}
  <div class="sectionbar"><h2>Форматы</h2>${button('Все публикации →', 'data-page="content"')}</div>
  ${formats.length ? `<table><thead><tr><th>Формат</th><th>Постов</th><th>${isFull() ? 'Мед. охват' : 'Мед. лайки'}</th><th>Мед. ER</th></tr></thead><tbody>${formats.map((f) => { const fp = cur.posts.filter((p) => p.format === f); return `<tr><td>${f}</td><td>${fp.length}</td><td>${n(median(fp.map((p) => (isFull() ? p.reach : p.likes))))}</td><td>${pct(median(fp.map((p) => p.er)), 2)}</td></tr>`; }).join('')}</tbody></table>` : '<p class="empty">Нет публикаций за период</p>'}
  <p class="notice">${isFull() ? 'Данные из Instagram по доступу клиента. ER по охвату = (лайки + комментарии + сохранения + репосты) / охват поста. Охват аккаунта и новые подписчики — дневная статистика Instagram (за последние 30 дней, дальше копится). Instagram обновляет цифры с задержкой до 48 часов.' : 'ER = (лайки + комментарии) / текущие подписчики. Подписчики на графике — снимки при каждом обновлении (раз в сутки), история копится с момента подключения. Охват, сохранения, репосты и Stories в открытых данных Instagram недоступны — для них пригласите клиента подключить Instagram.'}</p>
  <details><summary>Как читать график</summary><p>В режиме «Количество» ER использует правую шкалу в процентах, остальные линии — левую. Публикации — малые числа, они у нуля; отключите крупные показатели или выберите «Сравнить динамику».</p><p>В режиме сравнения максимум каждой линии в периоде равен 100%. Это относительная динамика, а не количество.</p><p>Просмотры, лайки и комментарии привязаны к дню публикации поста и отражают значения на момент последнего обновления, а не прирост за день.</p></details>
  </div>`;
  const scale = root.querySelector('#lm-chart-scale'); scale.value = C.scale;
  scale.onchange = (e) => { C.scale = e.target.value; drawChart(); };
  root.querySelector('#lm-top-metric').onchange = (e) => { S.topMetric = e.target.value; render(); };
  root.querySelectorAll('[data-series]').forEach((b) => (b.onclick = () => { const k = b.dataset.series; C.enabled.has(k) ? C.enabled.delete(k) : C.enabled.add(k); b.setAttribute('aria-pressed', String(C.enabled.has(k))); drawChart(); }));
  root.querySelector('#lm-chart-day').oninput = (e) => { C.idx = +e.target.value; drawChart(); };
  root.querySelectorAll('[data-period]').forEach((b) => (b.onclick = () => { if (b.dataset.period === 'custom') { C.preset = 'custom'; } else setPreset(b.dataset.period); render(); }));
  root.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => { C.step = b.dataset.step; C.idx = 1; render(); }));
  [['lm-period-prev', -1], ['lm-period-next', 1]].forEach(([id, dir]) => {
    const btn = root.querySelector('#' + id), next = moveRange(dir);
    btn.disabled = !next.valid;
    btn.onclick = () => { C.start = next.a; C.end = next.b; C.idx = 1; render(); };
  });
  const apply = root.querySelector('#lm-range-apply');
  if (apply) apply.onclick = () => {
    const av = availableRange();
    const a = root.querySelector('#lm-date-from').value, b = root.querySelector('#lm-date-to').value;
    if (!a || !b || a > b || b > av.end) { root.querySelector('#lm-range-error').textContent = `Укажите даты до ${dateLabel(av.end)}; начало не позже окончания.`; return; }
    C.start = a; C.end = b; C.idx = 1;
    const days = (asDate(b) - asDate(a)) / 86400000;
    C.step = days > 200 ? 'month' : days > 45 ? 'week' : 'day';
    render();
  };
  C.observer = new ResizeObserver(() => drawChart());
  C.observer.observe(root.querySelector('.plot'));
  drawChart();
}
function fmtSeries(s, v) { if (v === null || v === undefined) return '—'; return s.key === 'er' ? pct(v, 2) : n(v); }
function dayTable() {
  const r = C.rows[C.idx - 1]; if (!r) return;
  root.querySelector('#lm-day-title').textContent = r.label;
  root.querySelector('#lm-chart-day').value = C.idx;
  root.querySelector('#lm-day-values').innerHTML = SERIES.filter((s) => C.enabled.has(s.key)).map((s) => { const i = SERIES.indexOf(s); return `<tr><td><span class="labelrow"><span class="swatch" style="--series:var(--s${i});${i > 3 ? 'border-top-style:dashed' : ''}"></span>${s.label}</span></td><td><b>${fmtSeries(s, r[s.key])}</b></td></tr>`; }).join('') || '<tr><td colspan="2">Выберите показатели над графиком</td></tr>';
}
function drawChart() {
  const svgNode = root.querySelector('.daily-chart');
  if (!svgNode || !C.rows.length) return;
  dayTable();
  root.querySelector('#lm-scale-help').textContent = C.scale === 'absolute' ? 'Нажмите на точку · слева количество, справа ER %' : 'Максимум каждой линии = 100%';
  if (!window.d3) { svgNode.outerHTML = '<p class="notice">График не загрузился. Значения доступны в таблице.</p>'; return; }
  const d = d3, rows = C.rows, N = rows.length;
  const w = svgNode.getBoundingClientRect().width || 360, h = 280;
  const hasRight = C.scale === 'absolute' && C.enabled.has('er');
  const L = 50, R = hasRight ? 42 : 12, T = 28, B = 42;
  const chosen = SERIES.filter((s) => C.enabled.has(s.key));
  const maxima = Object.fromEntries(SERIES.map((s) => [s.key, d.max(rows, (r) => r[s.key])]));
  const value = (r, s) => { const v = r[s.key]; if (v === null || v === undefined) return null; return C.scale === 'relative' ? (maxima[s.key] ? (v / maxima[s.key]) * 100 : 0) : v; };
  const leftVals = rows.flatMap((r) => chosen.filter((s) => C.scale === 'relative' || !s.right).map((s) => value(r, s))).filter((v) => v !== null);
  const ymax = C.scale === 'relative' ? 105 : (d.max(leftVals) || 1) * 1.09;
  const x = d.scaleLinear().domain(N === 1 ? [0.5, 1.5] : [1, N]).range([L + 4, w - R - 4]);
  const y = d.scaleLinear().domain([0, ymax]).nice().range([h - B - 4, T + 4]);
  const yr = d.scaleLinear().domain([0, (maxima.er || 1) * 1.15]).nice().range([h - B - 4, T + 4]);
  const scaleFor = (s) => (s.right && C.scale === 'absolute' ? yr : y);
  const svg = d.select(svgNode);
  svg.attr('viewBox', `0 0 ${w} ${h}`); svg.selectAll('*').remove();
  svg.append('rect').attr('x', L).attr('y', T).attr('width', Math.max(0, w - L - R)).attr('height', h - T - B).attr('fill', 'none').attr('stroke', 'var(--line)');
  y.ticks(4).forEach((t) => {
    svg.append('line').attr('x1', L).attr('x2', w - R).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', 'var(--line)');
    svg.append('text').attr('x', L - 8).attr('y', y(t) + 4).attr('text-anchor', 'end').text(C.scale === 'relative' ? t + '%' : t >= 1000 ? (t / 1000).toLocaleString('ru-RU') + 'к' : t);
  });
  if (hasRight) {
    yr.ticks(3).forEach((t) => svg.append('text').attr('x', w - R + 6).attr('y', yr(t) + 4).attr('text-anchor', 'start').text(t.toLocaleString('ru-RU') + '%'));
    svg.append('text').attr('x', w - R).attr('y', 15).attr('text-anchor', 'end').text('ER, %');
  }
  [...new Set([1, Math.round(1 + (N - 1) / 3), Math.round(1 + (2 * (N - 1)) / 3), N])].forEach((t) => svg.append('text').attr('x', x(t)).attr('y', h - B + 18).attr('text-anchor', N === 1 ? 'middle' : t === 1 ? 'start' : t === N ? 'end' : 'middle').text(rows[t - 1].tick));
  svg.append('text').attr('x', L).attr('y', 15).text(C.scale === 'relative' ? '% от максимума' : 'Количество');
  svg.append('text').attr('x', (L + w - R) / 2).attr('y', h - 4).attr('text-anchor', 'middle').text(C.step === 'day' ? 'Дни' : C.step === 'week' ? 'Недели' : 'Месяцы');
  chosen.forEach((s) => {
    const i = SERIES.indexOf(s), sc = scaleFor(s);
    svg.append('path').datum(rows).attr('fill', 'none').attr('stroke', `var(--s${i})`).attr('stroke-width', 1.8)
      .attr('stroke-dasharray', i > 3 ? `6 ${3 + i}` : null)
      .attr('d', d.line().defined((r) => value(r, s) !== null).x((r) => x(r.i)).y((r) => sc(value(r, s))));
    const pts = rows.filter((r) => value(r, s) !== null);
    if (pts.length < N || N < 3) pts.forEach((r) => svg.append('circle').attr('cx', x(r.i)).attr('cy', sc(value(r, s))).attr('r', 2.2).attr('fill', `var(--s${i})`));
  });
  const marks = svg.append('g').attr('pointer-events', 'none');
  function mark(idx) {
    marks.selectAll('*').remove();
    const gx = x(idx), r = rows[idx - 1];
    marks.append('line').attr('x1', gx).attr('x2', gx).attr('y1', T).attr('y2', h - B).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '2 3');
    const points = chosen.map((s) => ({ s, i: SERIES.indexOf(s), v: value(r, s) })).filter((p) => p.v !== null)
      .map((p) => ({ ...p, py: scaleFor(p.s)(p.v), ly: 0 })).sort((a, b) => a.py - b.py);
    const gap = 21, minY = T + 10, maxY = h - B - 10;
    points.forEach((p, k) => (p.ly = Math.max(minY, p.py, k ? points[k - 1].ly + gap : minY)));
    if (points.length && points.at(-1).ly > maxY) { points.at(-1).ly = maxY; for (let k = points.length - 2; k >= 0; k--) points[k].ly = Math.min(points[k].ly, points[k + 1].ly - gap); }
    const right = gx < (L + w - R) / 2;
    points.forEach((p) => {
      const label = C.scale === 'relative' ? pct(p.v) : fmtSeries(p.s, r[p.s.key]);
      const tx = gx + (right ? 13 : -13);
      marks.append('path').attr('d', `M${gx},${p.py}L${gx + (right ? 7 : -7)},${p.ly}L${tx},${p.ly}`).attr('fill', 'none').attr('stroke', `var(--s${p.i})`).attr('stroke-width', 1);
      marks.append('circle').attr('cx', gx).attr('cy', p.py).attr('r', 3.5).attr('fill', `var(--s${p.i})`).attr('stroke', 'var(--paper)');
      const g = marks.append('g');
      const text = g.append('text').attr('x', tx).attr('y', p.ly + 4).attr('text-anchor', right ? 'start' : 'end').attr('class', 'point-value').text(label);
      const box = text.node().getBBox();
      g.insert('rect', 'text').attr('x', box.x - 4).attr('y', box.y - 2).attr('width', box.width + 8).attr('height', box.height + 4).attr('rx', 3).attr('fill', 'var(--paper)').attr('stroke', 'var(--line)');
    });
  }
  mark(C.idx);
  const tip = root.querySelector('#lm-chart-tip');
  const idxAt = (ev) => Math.round(Math.max(1, Math.min(N, x.invert(d.pointer(ev, svgNode)[0]))));
  svg.append('rect').attr('class', 'hit').attr('x', L).attr('y', T).attr('width', Math.max(0, w - L - R)).attr('height', h - T - B).attr('fill', 'transparent')
    .on('pointermove', (ev) => { const k = idxAt(ev); mark(k); tip.hidden = false; tip.textContent = rows[k - 1].label + ' · выбрать'; })
    .on('pointerleave', () => { tip.hidden = true; mark(C.idx); })
    .on('click', (ev) => { C.idx = idxAt(ev); dayTable(); mark(C.idx); tip.hidden = true; });
}

function thumb(p, big) { return `<span class="thumb">${p.thumb ? `<img src="${esc(mediaSrc(p.thumb))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`; }
function listItem(p, m) {
  const labels = { likes: 'лайков', views: 'просмотров', comments: 'комментариев', er: 'ER', reach: 'охват', saved: 'сохранений', shares: 'репостов' };
  const v = m === 'er' ? pct(p.er, 2) : n(p[m]);
  return button(`${thumb(p)}<span class="text">${esc(p.title)}<small>${dateLabel(p.date)} · ${p.format}${p.topic ? ' · ' + esc(p.topic) : ''}</small></span><span class="number">${v}<small>${labels[m]}</small></span>`, `data-post="${esc(p.id)}"`, 'listitem');
}

// ---------------- content: calendar & list ----------------
function monthBounds() {
  const av = availableRange();
  return { min: av.start.slice(0, 7), max: todayStr().slice(0, 7) };
}
function shiftMonth(m, k) { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return iso(d).slice(0, 7); }
function filteredPosts() {
  const q = S.query.trim().toLowerCase();
  return S.posts.filter((p) => (S.format === 'Все' || p.format === S.format) && (!q || (p.caption + ' ' + p.topic + ' ' + p.hook).toLowerCase().includes(q)));
}
function renderContent(banner) {
  const [y, m] = S.month.split('-').map(Number);
  const mb = monthBounds();
  const formats = ['Все', ...new Set(S.posts.map((p) => p.format)), ...(S.stories?.length ? ['Stories'] : [])];
  if (!formats.includes(S.format)) S.format = 'Все';
  screen.innerHTML = `${banner}<div class="month-title"><div class="month-nav">${button(icon('chevron-left'), `data-month="-1" aria-label="Предыдущий месяц" ${S.month <= mb.min ? 'disabled' : ''}`)}<b>${cap(MONTHS[m - 1])} ${y}</b>${button(icon('chevron-right'), `data-month="1" aria-label="Следующий месяц" ${S.month >= mb.max ? 'disabled' : ''}`)}</div><span>@${esc(S.data.profile?.username || '')}</span></div>
  <div class="tools"><select id="lm-format" aria-label="Тип контента">${formats.map((x) => `<option ${x === S.format ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
  <div class="modes">${[['grid', 'calendar-days', 'Календарь'], ['list', 'list', 'Список']].map(([v, i, t]) => button(icon(i) + t, `data-mode="${v}" aria-pressed="${S.mode === v}"`, S.mode === v ? 'active' : '')).join('')}</div>
  ${S.mode === 'list' ? `<div class="pad"><input class="search" id="lm-search" placeholder="Найти по тексту или хэштегу" aria-label="Поиск контента"></div>` : ''}
  <div id="lm-results"></div>`;
  const search = root.querySelector('#lm-search');
  if (search) { search.value = S.query; search.oninput = () => { S.query = search.value; results(); }; }
  root.querySelector('#lm-format').onchange = (e) => { S.format = e.target.value; render(); };
  results();
}
const LEGEND_PUBLIC = () => `<details class="content-legend"><summary class="cursor-interaction">${icon('info')} Обозначения</summary><div class="legend-body"><h3>Публикации</h3><div>${icon('message-circle')}<span>Комментарии</span></div><div>${icon('eye')}<span>Просмотры (только Reels и видео)</span></div><div>${icon('heart')}<span>Лайки</span></div><div>${icon('percent')}<span>ER: (лайки + комментарии) / подписчики</span></div><h3>Открыть</h3><div>${icon('align-left')}<span>Текст публикации</span></div><div>${icon('play')}<span>Фото, видео или карусель</span></div><p>«—» — нет данных: лайки скрыты автором или показатель не применяется (просмотры у фото).</p></div></details>`;
const LEGEND_FULL = () => `<details class="content-legend"><summary class="cursor-interaction">${icon('info')} Обозначения</summary><div class="legend-body"><h3>Публикации</h3><div>${icon('eye')}<span>Просмотры</span></div><div>${icon('users')}<span>Охват — уникальные аккаунты</span></div><div>${icon('bookmark')}<span>Сохранения</span></div><div>${icon('send')}<span>Репосты (отправки)</span></div><h3>Stories за день</h3><div>${icon('circle-play')}<span>Количество кадров</span></div><div>${icon('eye')}<span>Просмотры всех кадров</span></div><div>${icon('gauge')}<span>Средние просмотры на кадр</span></div><div>${icon('flag')}<span>Досмотр ≈ последний / первый кадр</span></div><div>${icon('message-circle')}<span>Ответы на Stories</span></div><h3>Открыть</h3><div>${icon('align-left')}<span>Текст публикации</span></div><div>${icon('play')}<span>Фото, видео или карусель</span></div><div>${icon('layers')}<span>Кадры Stories</span></div><p>«—» — нет данных. Метрики Instagram приходят с задержкой до 48 часов.</p></div></details>`;
const LEGEND = () => (isFull() ? LEGEND_FULL() : LEGEND_PUBLIC());
function storyTotals(list) {
  const views = list.map((x) => x.views ?? 0);
  const total = sum(views);
  return { count: list.length, total, average: list.length ? Math.round(total / list.length) : 0, completion: list.length > 1 && views[0] ? (views.at(-1) / views[0]) * 100 : null, replies: sumN(list.map((x) => x.replies)), reach: sumN(list.map((x) => x.reach)) };
}
function storyBox(ds) {
  const list = S.storyDays.get(ds); if (!list) return '';
  const v = storyTotals(list);
  const vals = [['circle-play', n(v.count), 'Кадров Stories: ' + v.count], ['eye', short(v.total), 'Просмотры всех кадров: ' + n(v.total)], ['gauge', short(v.average), 'Средние просмотры на кадр: ' + n(v.average)], ['flag', v.completion === null ? '—' : Math.round(v.completion) + '%', v.completion === null ? 'Досмотр не считается для одного кадра' : 'Досмотр ≈ ' + pct(v.completion)], ['message-circle', n(v.replies), 'Ответы: ' + n(v.replies)]];
  return `<article class="story-day-box compact-story" aria-label="Stories за ${dayLong(ds)}"><div class="story-icon-grid">${vals.map(([i, val, l]) => `<span class="story-stat" title="${esc(l)}" aria-label="${esc(l)}">${icon(i)}<span>${val}</span></span>`).join('')}<button class="cursor-interaction story-frames" data-story-day="${ds}" aria-label="Кадры Stories за ${dayLong(ds)}" title="Кадры Stories">${icon('layers')}</button></div></article>`;
}
function storyLine(ds) {
  const list = S.storyDays.get(ds); if (!list) return '';
  const v = storyTotals(list);
  const stat = (i, val, label) => `<span class="row-stat" title="${esc(label)}" aria-label="${esc(label)}">${icon(i)}<span>${val}</span></span>`;
  return `<div class="feed-line feed-stories"><span class="feed-title">Stories <b>${v.count}</b></span>${stat('eye', short(v.total), 'Просмотры: ' + n(v.total))}${stat('gauge', short(v.average), 'Среднее на кадр: ' + n(v.average))}${stat('flag', v.completion === null ? '—' : Math.round(v.completion) + '%', 'Досмотр ≈')}${stat('message-circle', n(v.replies), 'Ответы: ' + n(v.replies))}<div class="feed-actions">${button(icon('layers'), `data-story-day="${ds}" aria-label="Кадры Stories" title="Кадры Stories"`)}</div></div>`;
}
function stats(p) {
  if (isFull()) return [['eye', short(p.views), 'Просмотры: ' + n(p.views)], ['users', short(p.reach), 'Охват: ' + n(p.reach)], ['bookmark', short(p.saved), 'Сохранения: ' + n(p.saved)], ['send', short(p.shares), 'Репосты: ' + n(p.shares)]];
  return [['message-circle', n(p.comments), 'Комментарии: ' + n(p.comments)], ['eye', short(p.views), 'Просмотры: ' + n(p.views)], ['heart', short(p.likes), 'Лайки: ' + n(p.likes)], ['percent', p.er === null ? '—' : p.er.toFixed(1).replace('.', ','), 'ER: ' + pct(p.er, 2)]];
}
function actions(p) {
  return button(icon('align-left'), `data-open-text="${esc(p.id)}" aria-label="Открыть текст" title="Открыть текст"`) + button(icon('play'), `data-open-media="${esc(p.id)}" aria-label="Открыть контент" title="Открыть контент"`);
}
function brick(p) {
  return `<article class="brick"><span class="fmt">${p.format} · ${timeOf(p.timestamp)}</span><h3><button data-post="${esc(p.id)}">${esc(p.title)}</button></h3><div class="counts">${stats(p).map(([i, v, l]) => `<span class="count" title="${esc(l)}" aria-label="${esc(l)}">${icon(i)}${v}</span>`).join('')}</div><div class="brick-actions">${actions(p)}</div></article>`;
}
function compactList(arr, storyDates = []) {
  const days = [...new Set([...arr.map((p) => p.date), ...storyDates])].sort().reverse();
  if (!days.length) return '<p class="empty">Ничего не найдено</p>';
  const stat = (i, v, label) => `<span class="row-stat" title="${esc(label)}" aria-label="${esc(label)}">${icon(i)}<span>${v}</span></span>`;
  return `<div class="compact-feed">${days.map((day) => `<section class="feed-day"><div class="feed-date">${dayLong(day)}${S.query ? ' ' + day.slice(0, 4) : ''}</div>${storyLine(day)}${arr.filter((p) => p.date === day).map((p) => `<div class="feed-line"><span class="feed-title" data-post="${esc(p.id)}" role="button" tabindex="0">${esc(p.title)}<small>${p.format}</small></span>${stats(p).map(([i, v, l]) => stat(i, v, l)).join('')}<div class="feed-actions">${actions(p)}</div></div>`).join('')}</section>`).join('')}</div>`;
}
function results() {
  const host = root.querySelector('#lm-results');
  const onlyStories = S.format === 'Stories';
  const all = onlyStories ? [] : filteredPosts();
  const withStories = (S.format === 'Все' || onlyStories) && !S.query.trim();
  const storyDates = withStories ? [...S.storyDays.keys()] : [];
  const showStories = (ds) => withStories && S.storyDays.has(ds);
  if (S.mode === 'list') {
    const arr = S.query.trim() ? all : all.filter((p) => p.date.startsWith(S.month));
    host.innerHTML = LEGEND() + compactList(arr, storyDates.filter((d) => d.startsWith(S.month)));
  } else {
    const [y, m] = S.month.split('-').map(Number);
    const daysIn = new Date(y, m, 0).getDate();
    const t = todayStr();
    host.innerHTML = LEGEND() + `<div class="calendar-days unified-days">${Array.from({ length: daysIn }, (_, k) => k + 1).map((d) => {
      const ds = `${S.month}-${pad(d)}`, dow = new Date(y, m - 1, d).getDay();
      const ps = all.filter((p) => p.date === ds).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return `<section class="day-row" aria-label="${dayLong(ds)}"><time class="day-date ${dow === 0 || dow === 6 ? 'weekend' : ''}" datetime="${ds}"><b>${pad(d)}</b>${DOW[dow]}</time><div class="day-content">${ps.map(brick).join('')}${showStories(ds) ? storyBox(ds) : ''}${!ps.length && !showStories(ds) ? `<div class="no-posts">${ds > t ? '' : S.format === 'Все' ? '—' : 'Нет по фильтру'}</div>` : ''}</div></section>`;
    }).join('')}</div>`;
  }
  host.insertAdjacentHTML('beforeend', `<p class="data-note">Значения на момент обновления ${ago(S.data.sync?.lastSuccessAt)} · источник: ${isFull() ? 'Instagram' : 'Apify'}</p>`);
  drawIcons();
}

// ---------------- post page ----------------
function renderPost(banner) {
  const p = S.byId.get(S.selected);
  if (!p) { S.selected = null; return render(); }
  const rows = isFull()
    ? [['Охват', n(p.reach)], ['Просмотры', n(p.views)], ['Лайки', n(p.likes)], ['Комментарии', n(p.comments)], ['Сохранения', n(p.saved)], ['Репосты', n(p.shares)], ['ER по охвату', pct(p.er, 2)], ['Доля сохранений', p.reach ? pct(((p.saved || 0) / p.reach) * 100, 2) : '—'], ['Посещения профиля', n(p.profileVisits)], ...(p.avgWatchMs ? [['Среднее время просмотра', (p.avgWatchMs / 1000).toFixed(1).replace('.', ',') + ' с']] : [])]
    : [['Просмотры', n(p.views)], ['Лайки', n(p.likes)], ['Комментарии', n(p.comments)], ['ER', pct(p.er, 2)], ['Комментарии / лайки', p.likes ? pct(((p.comments || 0) / p.likes) * 100, 1) : '—']];
  if (p.duration) rows.push(['Длительность', Math.round(p.duration) + ' с']);
  screen.innerHTML = `${banner}<div class="pad">${button(icon('arrow-left') + 'Публикация', 'id="lm-back"', 'back')}
  <div class="posthead">${thumb(p)}<div><b>${esc(p.title)}</b><p class="sub">${dayLong(p.date)} ${p.date.slice(0, 4)}, ${timeOf(p.timestamp)} · ${p.format}${p.isPinned ? ' · закреплён' : ''}<br>Данные на ${ago(p.fetchedAt)}</p></div></div>
  <table><thead><tr><th>Показатель</th><th>Значение</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td><b>${r[1]}</b></td></tr>`).join('')}</tbody></table>
  <div style="display:flex;gap:16px;flex-wrap:wrap">${button(icon('align-left') + ' Текст', `data-open-text="${esc(p.id)}"`, 'ig-link')}${button(icon('play') + ' Контент', `data-open-media="${esc(p.id)}"`, 'ig-link')}${p.url ? `<a class="ig-link" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('external-link')} В Instagram</a>` : ''}</div>
  <details open><summary>Содержание публикации</summary><label>Тема<input id="lm-topic" class="edit"></label><label>Хук · из начала подписи<input id="lm-hook" class="edit"></label><label>CTA · из конца подписи<input id="lm-cta" class="edit"></label>${button('Сохранить правки', 'id="lm-save"', 'save')}<span class="sub" id="lm-saved" aria-live="polite"></span></details>
  ${isFull() ? '' : `<details><summary>Последние комментарии</summary>${p.latestComments?.length ? `<ul class="comments-list">${p.latestComments.map((c) => `<li><b>@${esc(c.user)}</b>${esc(c.text)}</li>`).join('')}</ul>` : '<p>Apify не вернул комментарии для этого поста.</p>'}</details>`}
  <details><summary>Источники метрик</summary>${isFull() ? '<p>Все показатели — статистика Instagram по доступу владельца аккаунта. Охват — уникальные аккаунты, просмотры — все показы. ER по охвату = (лайки + комментарии + сохранения + репосты) / охват.</p><p>Instagram обновляет цифры с задержкой до 48 часов. «—» — метрика не применяется к этому формату.</p>' : '<p>Лайки, комментарии и просмотры — открытые данные публикации, собранные Apify (instagram-scraper). ER = (лайки + комментарии) / текущее число подписчиков.</p><p>«—» — данных нет: автор скрыл лайки или метрика не применяется. Охват, сохранения и репосты видит только владелец аккаунта.</p>'}</details></div>`;
  root.querySelector('#lm-topic').value = p.topic || '';
  root.querySelector('#lm-hook').value = p.hook || '';
  root.querySelector('#lm-cta').value = p.cta || '';
}
async function savePost() {
  const p = S.byId.get(S.selected);
  const body = { topic: root.querySelector('#lm-topic').value, hook: root.querySelector('#lm-hook').value, cta: root.querySelector('#lm-cta').value };
  const st = root.querySelector('#lm-saved');
  try {
    await api('/api/annotations/' + encodeURIComponent(p.id), { method: 'PUT', body });
    Object.assign(p, body);
    S.data.annotations[p.id] = body;
    st.textContent = ' Сохранено';
  } catch (e) { st.textContent = ' ' + e.message; }
}

// ---------------- settings ----------------
function renderSettings(banner) {
  const s = S.data.sync || {}, pr = S.data.profile;
  const statusText = { ok: 'Готово', running: 'Идёт обновление…', error: 'Ошибка', idle: '—' }[s.status] || '—';
  const snaps = S.data.snapshots || [];
  screen.innerHTML = `${banner}<div class="pad"><h1>Данные и настройки</h1><p class="sub">${esc(S.me.email)}</p>
  <details open><summary>Клиенты и аккаунты</summary><div id="lm-clients"><div class="spinner"></div></div></details>
  <details${isFull() ? '' : ' open'}><summary>Текущий аккаунт</summary>${row('Instagram', '@' + esc(pr.username))}${row('Источник', S.data.mock ? 'Тестовые данные' : isFull() ? 'Instagram (доступ клиента)' : 'Apify (публичные данные)')}${isFull() ? row('Доступ действует до', fmtDate(S.data.tokenExpiresAt), 'продлевается сам') : ''}${row('Последнее обновление', ago(s.lastSuccessAt))}${row('Статус', statusText)}${s.status === 'error' ? `<div class="err-box">${esc(s.error)}</div>` : ''}${row('Публикаций в базе', n(S.posts.length))}${row('Снимков подписчиков', n(snaps.length), snaps.length ? 'с ' + dateLabel(snaps[0].date) : '')}
  ${button(`Обновить данные ${icon('refresh-cw')}`, `data-sync ${s.status === 'running' ? 'disabled' : ''}`, 'sync-btn')}
  <p>${isFull() ? 'Stories обновляются каждый час (Instagram хранит их статистику только 24 часа), остальное — раз в сутки.' : 'Обновление запускается автоматически раз в сутки — так копится история подписчиков.'} Вручную — не чаще раза в 15 минут.</p></details>
  <details><summary>Какие данные доступны</summary>${isFull() ? '<p>Есть: охват, просмотры, лайки, комментарии, сохранения, репосты, посещения профиля, среднее время просмотра Reels, Stories (охват, просмотры, ответы, переходы), охват аккаунта и новые подписчики по дням.</p><p>Данные Instagram обновляются с задержкой до 48 часов. Ответы на Stories у авторов из Европы Instagram отдаёт как 0. Статистика по дням доступна за последние 30 дней — дальше копится на сервере.</p>' : '<p>Есть: профиль (подписчики, подписки, число публикаций, био), публикации за последние 6 месяцев — тип, подпись, хэштеги, лайки, комментарии, просмотры Reels/видео, медиа.</p><p>Нет в открытых данных: охват, сохранения, репосты, посещения профиля, Stories. Чтобы их получить, пригласите клиента подключить Instagram — раздел «Клиенты и аккаунты».</p>'}</details>
  ${installBlock()}
  ${button(`Открытый профиль через Apify ${icon('chevron-right')}`, 'id="lm-edit-account"', 'settings-account-action')}
  ${button(`Выйти ${icon('log-out')}`, 'id="lm-logout"', 'settings-account-action')}</div>`;
  loadClients();
}
// ---------------- clients (connected Instagram accounts) ----------------
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—');
async function loadClients() {
  const host = root.querySelector('#lm-clients');
  if (!host) return;
  let d;
  try { d = await api('/api/sources'); } catch (e) { host.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
  const row = (x) => {
    const sub = x.kind === 'apify' ? 'публичные данные · Apify'
      : x.status === 'expired' ? 'доступ истёк — нужна новая ссылка'
      : `полный доступ · до ${fmtDate(x.tokenExpiresAt)}, продлевается сам`;
    const cur = x.key === d.current;
    return `<div class="client-row"><span class="account-initial">${x.avatar ? `<img src="${esc(mediaSrc(x.avatar))}" alt="" onerror="this.remove()">` : esc((x.username || '?')[0].toUpperCase())}</span><span class="client-text"><b>@${esc(x.username)}</b>${x.label ? ` <small>${esc(x.label)}</small>` : ''}<small>${sub}</small></span>${cur ? '<span class="tag">открыт</span>' : button('Открыть', `data-select="${esc(x.key)}"`, 'mini-btn')}${x.kind === 'instagram' ? button(icon('unlink'), `data-disconnect="${esc(x.key.slice(3))}" aria-label="Отключить" title="Отключить"`, 'mini-btn icon-only') : ''}</div>`;
  };
  const inv = (i) => `<div class="client-row"><span class="client-text"><b>${esc(i.label || 'Без названия')}</b><small>${i.usedBy ? 'подключён' : 'ждёт подключения'} · создана ${fmtDate(i.createdAt)}</small></span>${button(icon('copy'), `data-copy="${esc(i.url)}" aria-label="Скопировать ссылку" title="Скопировать ссылку"`, 'mini-btn icon-only')}${button(icon('x'), `data-revoke="${esc(i.token)}" aria-label="Удалить ссылку" title="Удалить ссылку"`, 'mini-btn icon-only')}</div>`;
  host.innerHTML = `<h2>Аккаунты</h2>${d.sources.length ? d.sources.map(row).join('') : '<p class="sub">Пока ни одного. Создайте ссылку ниже и отправьте клиенту.</p>'}
  <h2>Пригласить клиента</h2>
  ${d.igReady ? `<p class="sub">Клиент откроет ссылку, войдёт в свой Instagram и разрешит доступ к статистике. Пароль вы не увидите. Нужен профессиональный аккаунт (Бизнес или Автор).</p>
  <div class="invite-form"><input id="lm-invite-label" class="edit" placeholder="Имя клиента или бренд" maxlength="80">${button('Создать ссылку', 'id="lm-invite-create"', 'save')}</div><div id="lm-invite-result"></div>
  ${d.invites.length ? `<h2>Ссылки</h2>${d.invites.map(inv).join('')}` : ''}` : `<div class="err-box">Вход через Instagram ещё не настроен на сервере: нужно приложение Meta и переменные IG_APP_ID, IG_APP_SECRET.</div>`}`;
  drawIcons();
}
async function shareOrCopy(url, title) {
  if (navigator.share) { try { await navigator.share({ title, text: 'Подключите Instagram к аналитике по ссылке:', url }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); } catch { toast(url); }
}

// ---------------- PWA install ----------------
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (S.page === 'more' && S.stage === 'app') render(); });
addEventListener('appinstalled', () => { installEvent = null; toast('Приложение установлено'); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function installBlock() {
  if (standalone()) return '';
  if (installEvent) return button(`Установить на рабочий стол ${icon('download')}`, 'id="lm-install"', 'sync-btn');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<details><summary>Установить на рабочий стол</summary><p class="install-tip">${ios ? 'В Safari нажмите «Поделиться» ⬆︎ → «На экран „Домой“».' : 'В меню браузера ⋮ выберите «Установить приложение» или «Добавить на главный экран».'}</p></details>`;
}

async function requestSync() {
  try {
    await api('/api/sync', { method: 'POST' });
    S.data.sync = { ...S.data.sync, status: 'running' };
    render(); schedulePoll();
  } catch (e) { toast(e.message); }
}

// ---------------- popups ----------------
const popup = document.createElement('dialog');
popup.setAttribute('aria-labelledby', 'lm-popup-title');
root.appendChild(popup);
let lastTrigger = null, mediaPost = null, slide = 0;
function closePopup() { popup.querySelectorAll('video').forEach((v) => v.pause()); popup.close(); lastTrigger?.focus(); }
popup.addEventListener('cancel', () => popup.querySelectorAll('video').forEach((v) => v.pause()));
popup.addEventListener('click', (e) => {
  if (e.target === popup) return closePopup();
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.close !== undefined) closePopup();
  if (b.dataset.slide !== undefined) { slide += Number(b.dataset.slide); drawMedia(); }
});
const popupHead = (title) => `<div class="popup-head"><h2 id="lm-popup-title">${title}</h2><button data-close class="popup-close cursor-interaction" aria-label="Закрыть">${icon('x')}</button></div>`;
function drawMedia() {
  const p = mediaPost, items = p.media || [], m = items[slide];
  const gone = `<div class="media-gone">Ссылка на медиа устарела — Instagram меняет её через несколько дней. Обновите данные в настройках или откройте пост в Instagram.</div>`;
  const body = !m ? '<div class="media-gone">Медиа нет в данных Apify.</div>'
    : m.type === 'video' ? `<video controls playsinline preload="metadata" ${m.poster ? `poster="${esc(mediaSrc(m.poster))}"` : ''} src="${esc(mediaSrc(m.url))}"></video>`
      : `<img src="${esc(mediaSrc(m.url))}" alt="${esc(p.title)}, ${slide + 1}">`;
  popup.innerHTML = `${popupHead(`${p.format} · ${dateLabel(p.date)}`)}<p class="sub">${esc(p.title)}</p><div class="media-frame">${body}</div>${items.length > 1 ? `<div class="carousel-controls"><button data-slide="-1" class="cursor-interaction" aria-label="Предыдущий слайд" ${slide === 0 ? 'disabled' : ''}>${icon('chevron-left')}</button><span aria-live="polite">${slide + 1} / ${items.length}</span><button data-slide="1" class="cursor-interaction" aria-label="Следующий слайд" ${slide === items.length - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button></div>` : ''}${p.format === 'Reels' && m?.type !== 'video' ? '<p class="notice">Видео не пришло в данных — показана обложка.</p>' : ''}${p.url ? `<a class="ig-link" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('external-link')} Открыть в Instagram</a>` : ''}`;
  const el = popup.querySelector('.media-frame img, .media-frame video');
  if (el) el.addEventListener('error', () => { popup.querySelector('.media-frame').innerHTML = gone; }, { once: true });
  drawIcons();
}
function openText(p) {
  popup.innerHTML = `${popupHead('Текст публикации')}<p class="sub">${dateLabel(p.date)} · ${p.format}</p><div class="popup-text">${esc(p.caption || 'Подписи нет')}</div>${p.url ? `<a class="ig-link" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('external-link')} Открыть в Instagram</a>` : ''}`;
  drawIcons();
}

function openStories(ds) {
  const list = S.storyDays.get(ds) || [];
  const v = storyTotals(list);
  popup.innerHTML = `${popupHead(`Stories · ${dayLong(ds)}`)}<p class="sub">Кадров: ${v.count} · охват ${n(v.reach)} · просмотры ${n(v.total)}</p><table><thead><tr><th>Кадр</th><th>Просм.</th><th>Охват</th><th>Ответы</th><th>Переходы</th></tr></thead><tbody>${list.map((x, i) => `<tr><td>${i + 1} · ${timeOf(x.timestamp)}${x.url ? ` <a class="ig-link" href="${esc(x.url)}" target="_blank" rel="noopener">${icon('external-link')}</a>` : ''}</td><td>${n(x.views)}</td><td>${n(x.reach)}</td><td>${n(x.replies)}</td><td>${n(x.navigation)}</td></tr>`).join('')}<tr><td><b>Всего</b></td><td><b>${n(v.total)}</b></td><td></td><td><b>${n(v.replies)}</b></td><td></td></tr></tbody></table><p class="notice">Досмотр ≈ ${v.completion === null ? 'не считается для одного кадра' : pct(v.completion) + ' (просмотры последнего кадра / первого)'}. Instagram отдаёт статистику Stories только первые 24 часа — значения зафиксированы на последнем обновлении в это время. Ответы у авторов из Европы Instagram показывает как 0.</p>`;
  drawIcons();
}

// ---------------- events ----------------
root.addEventListener('click', (e) => {
  const storyBtn = e.target.closest('[data-story-day]');
  if (storyBtn) { lastTrigger = storyBtn; openStories(storyBtn.dataset.storyDay); popup.showModal(); return; }
  const opener = e.target.closest('[data-open-text],[data-open-media]');
  if (opener) {
    lastTrigger = opener;
    const p = S.byId.get(opener.dataset.openText ?? opener.dataset.openMedia);
    if (!p) return;
    if (opener.dataset.openText !== undefined) openText(p); else { mediaPost = p; slide = 0; drawMedia(); }
    popup.showModal();
    return;
  }
  const b = e.target.closest('button,[data-post]');
  if (!b || b.disabled) return;
  if (b.dataset.page) { S.page = b.dataset.page; S.selected = null; screen.scrollTop = 0; render(); }
  else if (b.dataset.mode) { S.mode = b.dataset.mode; S.query = ''; render(); }
  else if (b.dataset.month) { S.month = shiftMonth(S.month, Number(b.dataset.month)); render(); }
  else if (b.dataset.post !== undefined) { S.selected = b.dataset.post; screen.scrollTop = 0; render(); }
  else if (b.dataset.sync !== undefined) requestSync();
  else if (b.id === 'lm-back') { S.selected = null; render(); }
  else if (b.id === 'lm-save') savePost();
  else if (b.id === 'lm-edit-account') { clearTimeout(pollTimer); S.stage = 'instagram'; render(); }
  else if (b.id === 'lm-logout') logout();
  else if (b.id === 'lm-install' && installEvent) { installEvent.prompt(); installEvent.userChoice.finally(() => { installEvent = null; render(); }); }
  else if (b.dataset.select) {
    api('/api/sources/select', { method: 'POST', body: { key: b.dataset.select } }).then((m) => { S.me = m; S.page = 'overview'; S.selected = null; S.month = null; C.start = null; screen.scrollTop = 0; return loadData(); }).catch((err) => toast(err.message));
  } else if (b.dataset.disconnect) {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.classList.add('danger'); b.title = 'Нажмите ещё раз, чтобы отключить и удалить данные'; toast('Нажмите ещё раз, чтобы отключить аккаунт и удалить его данные'); return; }
    api('/api/connections/' + encodeURIComponent(b.dataset.disconnect), { method: 'DELETE' }).then(async () => { toast('Аккаунт отключён'); S.me = await api('/api/me'); if (!S.me.source) { S.stage = 'clients'; render(); } else if (S.stage === 'app') loadData(); else loadClients(); }).catch((err) => toast(err.message));
  } else if (b.dataset.copy) shareOrCopy(b.dataset.copy, 'Подключение Instagram');
  else if (b.dataset.revoke) api('/api/invites/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' }).then(loadClients);
  else if (b.id === 'lm-invite-create') {
    const label = root.querySelector('#lm-invite-label').value.trim();
    api('/api/invites', { method: 'POST', body: { label } }).then((r) => {
      loadClients().then(() => {
        const box = root.querySelector('#lm-invite-result');
        if (box) { box.innerHTML = `<div class="invite-link"><code>${esc(r.url)}</code>${button(`Отправить ${icon('share-2')}`, `data-copy="${esc(r.url)}"`, 'save')}</div>`; drawIcons(); }
      });
    }).catch((err) => toast(err.message));
  } else if (b.id === 'lm-retry') { requestSync().then(() => { S.data.sync.status = 'running'; render(); }); }
});
root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.feed-title[data-post]')) { S.selected = e.target.dataset.post; render(); }
});

boot();
renderAuth();
})();

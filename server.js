import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Store } from './lib/store.js';
import { fetchProfile, fetchPosts, isMock, ApifyError } from './lib/apify.js';
import { normalizeProfile, normalizePost, errorItem } from './lib/transform.js';
import { sendCode, smtpConfigured } from './lib/mailer.js';
import { mockSnapshots, mockMediaSvg } from './lib/mock.js';
import * as IG from './lib/instagram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FIRST_SYNC_MONTHS = Number(process.env.FIRST_SYNC_MONTHS || 6);
const POSTS_LIMIT = Number(process.env.POSTS_LIMIT || 150);
const REFRESH_DAYS = Number(process.env.REFRESH_DAYS || 30); // window re-read on later syncs
const MANUAL_SYNC_COOLDOWN_MIN = Number(process.env.MANUAL_SYNC_COOLDOWN_MIN || 15);
const AUTO_SYNC_HOURS = Number(process.env.AUTO_SYNC_HOURS || 24); // 0 disables
const PUBLIC_URL = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)).replace(/\/$/, '');
const IG_REDIRECT = `${PUBLIC_URL}/auth/instagram/callback`;
const STORY_SYNC_MIN = Number(process.env.STORY_SYNC_MIN || 60); // stories live 24 h — poll them often
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const store = new Store(DATA_DIR);
const SECRET = process.env.SESSION_SECRET || store.secret();
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// ---------- sessions (signed cookie) ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function setSession(res, email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 30 * 86400000 })).toString('base64url');
  res.cookie('cl_session', `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400000,
  });
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('cl_session='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(11).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}
function auth(req, res, next) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'Нужно войти' });
  req.user = store.user(s.email);
  next();
}

// ---------- login by email code ----------
const codes = new Map(); // email -> {hash, exp, tries, sentAt}
const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}:${SECRET}`).digest('hex');
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

app.post('/api/auth/request', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: 'Проверьте email.' });
  if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
    return res.status(403).json({ error: 'Этот email не добавлен в список доступа.' });
  }
  const prev = codes.get(email);
  if (prev && Date.now() - prev.sentAt < 30000) return res.status(429).json({ error: 'Подождите 30 секунд перед новым кодом.' });
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  codes.set(email, { hash: hashCode(email, code), exp: Date.now() + 10 * 60000, tries: 0, sentAt: Date.now() });
  try {
    const { delivered } = await sendCode(email, code);
    res.json({ ok: true, delivered, devCode: delivered ? undefined : code });
  } catch (e) {
    console.error('mail error', e);
    res.status(502).json({ error: 'Не удалось отправить письмо. Попробуйте позже.' });
  }
});

app.post('/api/auth/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const entry = codes.get(email);
  if (!entry || entry.exp < Date.now()) return res.status(400).json({ error: 'Код устарел. Запросите новый.' });
  if (++entry.tries > 5) { codes.delete(email); return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код.' }); }
  if (hashCode(email, code) !== entry.hash) return res.status(400).json({ error: 'Код не совпал.' });
  codes.delete(email);
  const user = store.user(email);
  store.save();
  setSession(res, email);
  res.json(me(user));
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('cl_session'); res.json({ ok: true }); });

const me = (u) => ({ email: u.email, handle: u.handle, source: currentSource(u), mock: isMock(), igReady: IG.igConfigured() });
// A user looks either at a public profile via Apify ("apify:<handle>") or at a client who connected Instagram ("ig:<id>").
function currentSource(u) {
  if (u.source?.startsWith('ig:') && store.db.connections?.[u.source.slice(3)]) return u.source;
  return u.handle ? `apify:${u.handle}` : null;
}
app.get('/api/me', auth, (req, res) => res.json(me(req.user)));

// ---------- account & sync ----------
const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const RESERVED = ['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct'];
const jobs = new Map();
const today = () => new Date().toISOString().slice(0, 10);

function syncAccount(handle, { reason }) {
  if (jobs.has(handle)) return jobs.get(handle);
  const acc = store.account(handle);
  const firstSync = !acc.profile || !acc.posts.length;
  acc.sync = { ...acc.sync, status: 'running', startedAt: new Date().toISOString(), reason, error: null };
  store.save();
  const job = (async () => {
    try {
      const since = firstSync
        ? new Date(Date.now() - FIRST_SYNC_MONTHS * 30.5 * 86400000).toISOString().slice(0, 10)
        : new Date(Date.now() - REFRESH_DAYS * 86400000).toISOString().slice(0, 10);
      const profileItems = await fetchProfile(handle);
      const err = errorItem(profileItems);
      const raw = (profileItems || []).find((i) => i && i.username);
      if (err || !raw) throw new ApifyError(`profile error ${JSON.stringify(err || {})}`, 'Профиль не найден. Проверьте ник.');
      if (raw.private) throw new ApifyError('private profile', 'Профиль закрыт — Apify видит только открытые аккаунты.');
      const profile = normalizeProfile(raw);

      let postItems = await fetchPosts(handle, { since, limit: firstSync ? POSTS_LIMIT : Math.min(POSTS_LIMIT, 60) });
      postItems = (postItems || []).filter((p) => p && !p.error && (p.id || p.shortCode) && p.timestamp);
      if (!postItems.length && Array.isArray(raw.latestPosts)) postItems = raw.latestPosts;

      const byId = new Map(acc.posts.map((p) => [p.id, p]));
      for (const it of postItems) {
        const p = normalizePost(it);
        byId.set(p.id, { ...byId.get(p.id), ...p, fetchedAt: new Date().toISOString() });
      }
      acc.posts = [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      acc.profile = profile;

      if (isMock() && !acc.snapshots.length) acc.snapshots = mockSnapshots(handle);
      const snap = { date: today(), followers: profile.followers, following: profile.following, postsCount: profile.postsCount };
      acc.snapshots = acc.snapshots.filter((s) => s.date !== snap.date).concat(snap).sort((a, b) => a.date.localeCompare(b.date));

      acc.sync = { status: 'ok', finishedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), reason, error: null };
    } catch (e) {
      console.error(`sync ${handle} failed:`, e.message);
      acc.sync = { ...acc.sync, status: 'error', finishedAt: new Date().toISOString(), error: e.userMessage || 'Не удалось получить данные.' };
    } finally {
      store.save();
      jobs.delete(handle);
    }
  })();
  jobs.set(handle, job);
  return job;
}

app.post('/api/account', auth, (req, res) => {
  const handle = String(req.body.handle || '').trim().toLowerCase().replace(/^@/, '');
  if (!HANDLE_RE.test(handle) || RESERVED.includes(handle)) return res.status(400).json({ error: 'Укажите ник или ссылку на профиль Instagram.' });
  req.user.handle = handle;
  const acc = store.account(handle);
  store.save();
  if (!acc.profile && acc.sync.status !== 'running') syncAccount(handle, { reason: 'first' });
  res.json(me(req.user));
});

app.post('/api/sync', auth, (req, res) => {
  const src = currentSource(req.user);
  if (src?.startsWith('ig:')) {
    const c = store.db.connections[src.slice(3)];
    const last = c.sync?.finishedAt ? Date.parse(c.sync.finishedAt) : 0;
    const wait = MANUAL_SYNC_COOLDOWN_MIN * 60000 - (Date.now() - last);
    if (c.sync?.status === 'ok' && wait > 0) return res.status(429).json({ error: `Данные обновлялись недавно. Повторить можно через ${Math.ceil(wait / 60000)} мин.` });
    syncConnection(c.id, { reason: 'manual', full: true });
    return res.json({ ok: true, sync: c.sync });
  }
  const handle = req.user.handle;
  if (!handle) return res.status(400).json({ error: 'Сначала выберите аккаунт.' });
  const acc = store.account(handle);
  const last = acc.sync.finishedAt ? Date.parse(acc.sync.finishedAt) : 0;
  const wait = MANUAL_SYNC_COOLDOWN_MIN * 60000 - (Date.now() - last);
  if (acc.sync.status === 'ok' && wait > 0) {
    return res.status(429).json({ error: `Данные обновлялись недавно. Повторить можно через ${Math.ceil(wait / 60000)} мин.` });
  }
  syncAccount(handle, { reason: 'manual' });
  res.json({ ok: true, sync: acc.sync });
});

app.get('/api/data', auth, (req, res) => {
  const src = currentSource(req.user);
  if (src?.startsWith('ig:')) {
    const c = store.db.connections[src.slice(3)];
    const last = c.sync?.lastSuccessAt ? Date.parse(c.sync.lastSuccessAt) : 0;
    if (c.status === 'active' && c.sync?.status !== 'running' && Date.now() - last > STORY_SYNC_MIN * 60000) syncConnection(c.id, { reason: 'auto', full: Date.now() - (c.lastFullAt || 0) > AUTO_SYNC_HOURS * 3600000 });
    return res.json(connectionPayload(c));
  }
  const handle = req.user.handle;
  if (!handle) return res.status(400).json({ error: 'Сначала выберите аккаунт.' });
  const acc = store.account(handle);
  const last = acc.sync.lastSuccessAt ? Date.parse(acc.sync.lastSuccessAt) : 0;
  if (AUTO_SYNC_HOURS > 0 && acc.profile && acc.sync.status !== 'running' && Date.now() - last > AUTO_SYNC_HOURS * 3600000) syncAccount(handle, { reason: 'auto' });
  res.json({ ...acc, source: 'apify', annotations: store.annotations(handle), mock: isMock() });
});

const AUDIT_DIR = path.join(DATA_DIR, 'audits');
const safeHandle = (h) => /^[a-z0-9._]{1,40}$/.test(h) ? h : null;

// Приём готового отчёта из ig-audit. Отдельный токен, не сессия:
// заливает скрипт, а не браузер.
app.put('/api/audit/report/:handle', express.text({ type: '*/*', limit: '4mb' }), (req, res) => {
  const token = process.env.AUDIT_UPLOAD_TOKEN;
  if (!token || req.get('x-audit-token') !== token) return res.status(401).json({ error: 'Нет доступа' });
  const handle = safeHandle(String(req.params.handle || '').toLowerCase());
  if (!handle) return res.status(400).json({ error: 'Некорректный аккаунт' });
  if (!req.body || req.body.length < 100) return res.status(400).json({ error: 'Пустой отчёт' });
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIT_DIR, handle + '.html'), req.body);
  res.json({ ok: true, url: `/audit/${handle}` });
});

// Показ. Под сессией — отчёт открывает владелец аккаунта в content-lens.
app.get('/audit/:handle', auth, (req, res) => {
  const handle = safeHandle(String(req.params.handle || '').toLowerCase());
  if (!handle) return res.status(400).send('Некорректный аккаунт');
  const file = path.join(AUDIT_DIR, handle + '.html');
  if (!fs.existsSync(file)) return res.status(404).send('Разбор ещё не готов');
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
     .send(fs.readFileSync(file));
});

// ---------- экспорт для ig-audit (см. ig-audit/CONTRACT.md) ----------
const AUDIT_SCHEMA_VERSION = 1;
app.get('/api/audit/export', auth, (req, res) => {
  const handle = String(req.query.handle || req.user.handle || '').trim().toLowerCase();
  if (!handle) return res.status(400).json({ error: 'Сначала выберите аккаунт.' });
  const acc = store.account(handle);
  if (!acc.profile) return res.status(400).json({ error: 'Аккаунт ещё не синхронизирован.' });
  const p = acc.profile;
  res.json({
    schema_version: AUDIT_SCHEMA_VERSION,
    username: handle,
    collected_at: acc.sync?.lastSuccessAt || null,
    profile: {
      username: handle,
      fullName: p.fullName ?? '',
      biography: p.biography ?? '',
      followersCount: p.followers ?? null,
      followsCount: p.following ?? null,
      postsCount: p.postsCount ?? null,
      verified: !!p.verified,
      businessCategoryName: p.category ?? null,
      // Массив, даже когда интерфейс показывает одну ссылку.
      externalUrls: p.externalUrls?.length ? p.externalUrls
        : (p.externalUrl ? [p.externalUrl] : []),
      highlightReelCount: p.highlightReelCount ?? null,
    },
    // Названий актуальных профильный актор не отдаёт — см. CONTRACT.md.
    highlights: [],
    posts: acc.posts || [],
    landing: null,
    products: [],
    sources: {
      profile: 'apify/instagram-profile-scraper',
      posts: 'apify/instagram-scraper',
      highlights: 'нет источника: актор отдаёт только highlightReelCount',
    },
  });
});

app.put('/api/annotations/:postId', auth, (req, res) => {
  const src = currentSource(req.user);
  if (!src) return res.status(400).json({ error: 'Нет аккаунта' });
  const handle = src.startsWith('ig:') ? src : req.user.handle;
  const clip = (v) => String(v ?? '').slice(0, 500);
  store.annotations(handle)[req.params.postId] = { topic: clip(req.body.topic), hook: clip(req.body.hook), cta: clip(req.body.cta) };
  store.save();
  res.json({ ok: true });
});

// ---------- connected clients (Instagram Login) ----------
store.db.connections ||= {};
store.db.invites ||= {};
const encKey = crypto.createHash('sha256').update('tokens:' + SECRET).digest();
const seal = (t) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', encKey, iv); const x = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), x].map((b) => b.toString('base64url')).join('.'); };
const unseal = (s) => { const [iv, tag, x] = s.split('.').map((p) => Buffer.from(p, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv); d.setAuthTag(tag); return Buffer.concat([d.update(x), d.final()]).toString('utf8'); };
const igJobs = new Map();

function connectionPayload(c) {
  return {
    source: 'instagram', mock: IG.igMock(), id: c.id, status: c.status, connectedAt: c.connectedAt, tokenExpiresAt: c.tokenExpiresAt,
    permissions: c.permissions || [], profile: c.profile, posts: c.posts || [], stories: c.stories || [], daily: c.daily || {},
    snapshots: c.snapshots || [], sync: c.sync || { status: 'idle' }, annotations: store.annotations(`ig:${c.id}`),
  };
}

function syncConnection(id, { reason, full = true }) {
  if (igJobs.has(id)) return igJobs.get(id);
  const c = store.db.connections[id];
  c.sync = { ...c.sync, status: 'running', startedAt: new Date().toISOString(), reason, error: null };
  store.save();
  const job = (async () => {
    try {
      let token = unseal(c.token);
      if (c.tokenExpiresAt - Date.now() < 15 * 86400000) { // keep the 60-day token alive
        const r = await IG.refreshToken(token).catch(() => null);
        if (r) { token = r.token; c.token = seal(r.token); c.tokenExpiresAt = r.expiresAt; }
      }
      const firstSync = !c.profile || !(c.posts || []).length;
      const stories = await IG.fetchStories(token);
      const byStory = new Map((c.stories || []).map((s) => [s.id, s]));
      for (const s of stories) byStory.set(s.id, { ...byStory.get(s.id), ...s, fetchedAt: new Date().toISOString() });
      // stories older than 24 h are no longer returned: freeze their last values
      for (const s of byStory.values()) if (Date.now() - Date.parse(s.timestamp) > 24 * 3600000) s.final = true;
      c.stories = [...byStory.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      if (IG.igMock() && c.stories.length < 10) c.stories = [...IG.mockStoryHistory(), ...c.stories];

      if (full || firstSync) {
        const profile = await IG.fetchProfile(token);
        const known = new Map((c.posts || []).map((p) => [p.id, p]));
        const sinceMs = Date.now() - (firstSync ? FIRST_SYNC_MONTHS * 30.5 : REFRESH_DAYS) * 86400000;
        const media = await IG.fetchMedia(token, { sinceMs, refreshSinceMs: Date.now() - REFRESH_DAYS * 86400000, known, limit: POSTS_LIMIT * 2 });
        for (const p of media) known.set(p.id, { ...known.get(p.id), ...p, fetchedAt: new Date().toISOString() });
        c.posts = [...known.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        c.daily = { ...(c.daily || {}), ...(await IG.fetchDaily(token, 30)) };
        c.profile = profile;
        c.username = profile.username;
        const snap = { date: today(), followers: profile.followers, following: profile.following, postsCount: profile.postsCount };
        c.snapshots = (c.snapshots || []).filter((s) => s.date !== snap.date).concat(snap).sort((a, b) => a.date.localeCompare(b.date));
        c.lastFullAt = Date.now();
      }
      c.status = 'active';
      c.sync = { status: 'ok', finishedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), reason, error: null };
    } catch (e) {
      console.error(`ig sync ${id} failed:`, e.message);
      if (e.code === 'expired') c.status = 'expired';
      c.sync = { ...c.sync, status: 'error', finishedAt: new Date().toISOString(), error: e.userMessage || 'Не удалось получить данные Instagram.' };
    } finally {
      store.save();
      igJobs.delete(id);
    }
  })();
  igJobs.set(id, job);
  return job;
}

// Accounts the team can switch between
app.get('/api/sources', auth, (req, res) => {
  const list = Object.values(store.db.connections).map((c) => ({
    key: `ig:${c.id}`, kind: 'instagram', username: c.username || c.profile?.username || '—', status: c.status,
    connectedAt: c.connectedAt, tokenExpiresAt: c.tokenExpiresAt, label: c.label || '', avatar: c.profile?.avatar || null,
  }));
  if (req.user.handle) list.unshift({ key: `apify:${req.user.handle}`, kind: 'apify', username: req.user.handle, status: 'active' });
  const invites = Object.values(store.db.invites).filter((i) => !i.revoked).map((i) => ({ token: i.token, label: i.label, createdAt: i.createdAt, url: `${PUBLIC_URL}/connect/${i.token}`, usedBy: i.usedBy || null }));
  res.json({ current: currentSource(req.user), sources: list, invites: invites.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), igReady: IG.igConfigured() });
});

app.post('/api/sources/select', auth, (req, res) => {
  const key = String(req.body.key || '');
  if (key.startsWith('ig:') && store.db.connections[key.slice(3)]) req.user.source = key;
  else if (key.startsWith('apify:')) { req.user.source = null; req.user.handle = key.slice(6); }
  else return res.status(400).json({ error: 'Нет такого аккаунта' });
  store.save();
  res.json(me(req.user));
});

app.post('/api/invites', auth, (req, res) => {
  if (!IG.igConfigured()) return res.status(400).json({ error: 'Подключение Instagram ещё не настроено: нужны IG_APP_ID и IG_APP_SECRET.' });
  const token = crypto.randomBytes(9).toString('base64url');
  store.db.invites[token] = { token, label: String(req.body.label || '').slice(0, 80), createdBy: req.user.email, createdAt: new Date().toISOString() };
  store.save();
  res.json({ token, url: `${PUBLIC_URL}/connect/${token}` });
});

app.delete('/api/invites/:token', auth, (req, res) => {
  const i = store.db.invites[req.params.token];
  if (i) { i.revoked = true; store.save(); }
  res.json({ ok: true });
});

app.delete('/api/connections/:id', auth, (req, res) => {
  const c = store.db.connections[req.params.id];
  if (!c) return res.status(404).json({ error: 'Нет такого подключения' });
  delete store.db.connections[req.params.id]; // token and data are removed; client can reconnect via invite
  for (const u of Object.values(store.db.users)) if (u.source === `ig:${req.params.id}`) u.source = null;
  store.save();
  res.json({ ok: true });
});

// ---------- public pages for the client ----------
const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root{color-scheme:light dark;--ink:light-dark(#18191d,#f5f5f7);--muted:light-dark(#74777f,#a4a6af);--line:light-dark(#ececf0,#303237);--soft:light-dark(#f4f4f7,#24262c);--accent:light-dark(#6353d5,#baaaff);--paper:light-dark(#fff,#161719)}
body{margin:0;background:var(--soft);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{max-width:440px;width:100%;background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:28px 24px}
.brand{font-weight:650;letter-spacing:-.5px;font-size:18px;margin-bottom:28px}h1{font-size:26px;line-height:1.15;letter-spacing:-.6px;margin:0 0 12px}
p,li{color:var(--muted)}ul{padding-left:18px}b{color:var(--ink)}.btn{display:block;text-align:center;background:var(--accent);color:var(--paper);text-decoration:none;font-weight:600;border-radius:10px;padding:14px;margin:22px 0 10px}
.box{background:var(--soft);border-radius:10px;padding:12px 14px;margin:14px 0}.small{font-size:12px}a{color:var(--accent)}
</style></head><body><main><div class="brand">content lens</div>${body}</main></body></html>`;
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/connect/:token', (req, res) => {
  const inv = store.db.invites[req.params.token];
  if (!inv || inv.revoked) return res.status(404).send(page('Ссылка недействительна', '<h1>Ссылка недействительна</h1><p>Попросите новую ссылку у того, кто вам её отправил.</p>'));
  res.send(page('Доступ к статистике Instagram', `<h1>Доступ к статистике вашего Instagram</h1>
<p>${inv.label ? `<b>${escHtml(inv.label)}</b> — ` : ''}для аналитики контента нам нужен доступ только на чтение статистики.</p>
<div class="box"><b>Что мы увидим</b><ul><li>охват, просмотры, сохранения и репосты публикаций</li><li>статистику Stories</li><li>число подписчиков и его динамику</li></ul>
<b>Что недоступно</b><ul><li>ваш пароль — вход идёт на сайте Instagram</li><li>личные сообщения</li><li>публикация и удаление контента</li></ul></div>
<p class="small">Нужен профессиональный аккаунт Instagram (Бизнес или Автор). Доступ можно отозвать в любой момент: Instagram → Настройки → Приложения и сайты.</p>
<a class="btn" href="/connect/${escHtml(inv.token)}/start">Подключить Instagram</a>
<p class="small"><a href="/privacy">Политика конфиденциальности</a></p>`));
});

app.get('/connect/:token/start', (req, res) => {
  const inv = store.db.invites[req.params.token];
  if (!inv || inv.revoked || !IG.igConfigured()) return res.redirect(`/connect/${encodeURIComponent(req.params.token)}`);
  res.redirect(IG.authorizeUrl({ redirectUri: IG_REDIRECT, state: inv.token }));
});

app.get('/auth/instagram/callback', async (req, res) => {
  const inv = store.db.invites[String(req.query.state || '')];
  if (!inv || inv.revoked) return res.status(400).send(page('Ошибка', '<h1>Ссылка недействительна</h1><p>Попросите новую ссылку.</p>'));
  if (req.query.error || !req.query.code) {
    return res.send(page('Доступ не выдан', `<h1>Доступ не выдан</h1><p>Вы отменили подключение. Если это случайность — попробуйте ещё раз.</p><a class="btn" href="/connect/${escHtml(inv.token)}/start">Подключить снова</a>`));
  }
  try {
    const t = await IG.exchangeCode({ code: String(req.query.code).replace(/#_$/, ''), redirectUri: IG_REDIRECT });
    const prev = store.db.connections[t.userId] || {};
    const c = store.db.connections[t.userId] = {
      ...prev, id: t.userId, token: seal(t.token), tokenExpiresAt: t.expiresAt, permissions: t.permissions,
      connectedAt: prev.connectedAt || new Date().toISOString(), reconnectedAt: new Date().toISOString(),
      invite: inv.token, label: inv.label || prev.label || '', status: 'active', sync: prev.sync || { status: 'idle' },
    };
    inv.usedBy = t.userId; inv.usedAt = new Date().toISOString();
    store.save();
    const profile = await IG.fetchProfile(t.token).catch(() => null);
    if (profile) { c.profile = profile; c.username = profile.username; store.save(); }
    syncConnection(c.id, { reason: 'first', full: true });
    const missing = IG.SCOPES.filter((s) => t.permissions.length && !t.permissions.includes(s));
    res.send(page('Готово', `<h1>Готово, доступ выдан</h1><p>${profile ? `Аккаунт <b>@${escHtml(profile.username)}</b> подключён.` : 'Аккаунт подключён.'} Можно закрыть эту страницу.</p>${missing.length ? '<div class="box">Вы сняли галочку со статистики — часть данных будет недоступна. Можно подключиться заново и оставить все разрешения.</div>' : ''}<p class="small">Отозвать доступ: Instagram → Настройки → Приложения и сайты.</p>`));
  } catch (e) {
    console.error('ig callback failed:', e.message);
    res.status(500).send(page('Ошибка', `<h1>Не получилось подключить</h1><p>${escHtml(e.userMessage || 'Ошибка Instagram')}</p><p class="small">Проверьте, что аккаунт профессиональный (Бизнес или Автор), и попробуйте снова.</p><a class="btn" href="/connect/${escHtml(inv.token)}/start">Попробовать снова</a>`));
  }
});

app.get('/privacy', (req, res) => res.send(page('Политика конфиденциальности', `<h1>Политика конфиденциальности</h1>
<p>content lens — сервис аналитики контента Instagram. Владелец аккаунта сам подключает его через официальный вход Instagram и выдаёт доступ только на чтение.</p>
<p><b>Какие данные получаем:</b> публичные данные профиля (ник, имя, фото, описание, число подписчиков и публикаций), публикации и Stories с их статистикой (охват, просмотры, лайки, комментарии, сохранения, репосты), статистику аккаунта по дням. Пароль, личные сообщения и данные подписчиков мы не получаем.</p>
<p><b>Зачем:</b> чтобы показать владельцу аккаунта и его SMM-специалисту аналитику контента. Данные не продаются и не передаются третьим лицам.</p>
<p><b>Хранение:</b> данные и ключ доступа хранятся на сервере в зашифрованном виде, пока аккаунт подключён. Ключ действует 60 дней и продлевается автоматически.</p>
<p><b>Как отозвать доступ и удалить данные:</b> Instagram → Настройки → Приложения и сайты → удалить content lens; затем напишите нам — мы удалим все сохранённые данные в течение 7 дней. Подробнее: <a href="/data-deletion">удаление данных</a>.</p>`)));
app.get('/data-deletion', (req, res) => res.send(page('Удаление данных', `<h1>Удаление данных</h1><p>Чтобы удалить данные вашего Instagram из content lens:</p><ul><li>отзовите доступ: Instagram → Настройки → Приложения и сайты → content lens → Удалить;</li><li>напишите специалисту, который прислал вам ссылку на подключение, — данные будут удалены в течение 7 дней.</li></ul><p>После отзыва доступа сервис больше не может получать новые данные.</p>`)));

// ---------- media proxy (Instagram CDN blocks hotlinking) ----------
const MEDIA_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
app.get('/api/media', auth, async (req, res) => {
  let url;
  try { url = new URL(String(req.query.u)); } catch { return res.status(400).end(); }
  if (url.protocol !== 'https:' || !MEDIA_HOSTS.test(url.hostname)) return res.status(400).end();
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await fetch(url, { headers });
    if (!r.ok && r.status !== 206) return res.status(r.status === 403 ? 410 : 502).end();
    res.status(r.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/mock-media/:name', (req, res) => {
  if (!isMock() && !IG.igMock()) return res.status(404).end();
  res.type('image/svg+xml').send(mockMediaSvg(req.params.name.replace(/\.svg$/, ''), String(req.query.t || ''), String(req.query.f || '')));
});

// ---------- static ----------
const EMBED = globalThis.__CL_ASSETS; // single-file build: gzipped assets embedded in the bundle
if (EMBED) {
  for (const [route, { type, b64 }] of Object.entries(EMBED)) {
    const buf = Buffer.from(b64, 'base64');
    app.get(route, (req, res) => res.set({ 'Content-Type': type, 'Content-Encoding': 'gzip', 'Cache-Control': ['/', '/index.html', '/sw.js', '/manifest.webmanifest'].includes(route) ? 'no-cache' : 'public, max-age=3600' }).send(buf));
  }
}
app.use('/vendor/d3.min.js', express.static(path.join(__dirname, 'node_modules/d3/dist/d3.min.js')));
app.use('/vendor/lucide.min.js', express.static(path.join(__dirname, 'node_modules/lucide/dist/umd/lucide.min.js')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- daily auto-sync builds follower history ----------
if (AUTO_SYNC_HOURS > 0) {
  setInterval(() => {
    const handles = new Set(Object.values(store.db.users).map((u) => u.handle).filter(Boolean));
    for (const h of handles) {
      const acc = store.account(h);
      const last = acc.sync.lastSuccessAt ? Date.parse(acc.sync.lastSuccessAt) : 0;
      if (Date.now() - last > AUTO_SYNC_HOURS * 3600000 && acc.sync.status !== 'running') syncAccount(h, { reason: 'auto' });
    }
  }, 10 * 60000).unref();
}
// Connected clients: stories every STORY_SYNC_MIN (they vanish after 24 h), everything else daily.
setInterval(() => {
  for (const c of Object.values(store.db.connections || {})) {
    if (c.status !== 'active' || c.sync?.status === 'running') continue;
    const last = c.sync?.lastSuccessAt ? Date.parse(c.sync.lastSuccessAt) : 0;
    if (Date.now() - last < STORY_SYNC_MIN * 60000) continue;
    syncConnection(c.id, { reason: 'auto', full: Date.now() - (c.lastFullAt || 0) > AUTO_SYNC_HOURS * 3600000 });
  }
}, 5 * 60000).unref();

// Data collected under APIFY_MOCK / IG_MOCK must not mix with real data: drop it and send its users back to account selection.
{
  const fake = (x) => JSON.stringify(x).includes('/mock-media/');
  const accs = isMock() ? [] : Object.keys(store.db.accounts).filter((h) => fake([store.db.accounts[h].profile, store.db.accounts[h].posts]));
  const conns = IG.igMock() ? [] : Object.keys(store.db.connections || {}).filter((id) => fake(store.db.connections[id].profile));
  for (const h of accs) delete store.db.accounts[h], delete store.db.annotations[h];
  for (const id of conns) delete store.db.connections[id], delete store.db.annotations[`ig:${id}`];
  for (const u of Object.values(store.db.users)) {
    if (accs.includes(u.handle)) u.handle = null;
    if (conns.some((id) => u.source === `ig:${id}`)) u.source = null;
  }
  if (accs.length || conns.length) { store.flush(); console.log(`removed test data: ${[...accs.map((h) => '@' + h), ...conns.map((id) => 'ig:' + id)].join(', ')}`); }
}

// A crash mid-sync leaves status "running" in the file; reset it on boot.
for (const acc of [...Object.values(store.db.accounts), ...Object.values(store.db.connections || {})]) if (acc.sync?.status === 'running') acc.sync.status = 'error', acc.sync.error = 'Обновление прервалось. Запустите снова.';

app.listen(PORT, () => {
  console.log(`content lens on :${PORT}${isMock() ? ' (APIFY_MOCK — test data)' : ''}${smtpConfigured() ? '' : ' (dev login: codes shown on screen)'}`);
});

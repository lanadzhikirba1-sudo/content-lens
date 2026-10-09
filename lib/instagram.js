// Instagram API with Instagram Login (Business Login for Instagram).
// The client authorises our Meta app; we keep a 60-day token (refreshed automatically)
// and read profile, media, media insights, stories and daily account insights.
// IG_MOCK=1 replaces all Graph calls with generated data for local testing.

const GV = process.env.IG_GRAPH_VERSION || 'v23.0';
const GRAPH = `https://graph.instagram.com/${GV}`;
export const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
export const igMock = () => process.env.IG_MOCK === '1' || process.env.IG_MOCK === 'true';
export const igConfigured = () => igMock() || (!!process.env.IG_APP_ID && !!process.env.IG_APP_SECRET);

export class IgError extends Error {
  constructor(message, userMessage, code) { super(message); this.userMessage = userMessage || message; this.code = code; }
}

export function authorizeUrl({ redirectUri, state }) {
  if (igMock()) return `${redirectUri}?code=mock&state=${encodeURIComponent(state)}`;
  const q = new URLSearchParams({ client_id: process.env.IG_APP_ID, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(','), state });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

// code -> long-lived token (60 days)
export async function exchangeCode({ code, redirectUri }) {
  if (igMock()) return { token: 'mock-token-' + Math.random().toString(36).slice(2), userId: '17841400000000001', expiresAt: Date.now() + 60 * 86400000, permissions: SCOPES };
  const body = new URLSearchParams({ client_id: process.env.IG_APP_ID, client_secret: process.env.IG_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri, code });
  const r = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new IgError(`token exchange ${r.status}: ${JSON.stringify(j)}`, 'Instagram не выдал доступ. Попробуйте ещё раз.');
  const short = j.access_token;
  const userId = String(j.user_id);
  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: process.env.IG_APP_SECRET, access_token: short });
  const r2 = await fetch(`https://graph.instagram.com/access_token?${q}`);
  const j2 = await r2.json().catch(() => ({}));
  if (!r2.ok || !j2.access_token) throw new IgError(`long-lived exchange ${r2.status}: ${JSON.stringify(j2)}`, 'Не удалось получить постоянный доступ к Instagram.');
  const perms = Array.isArray(j.permissions) ? j.permissions : String(j.permissions || '').split(',').filter(Boolean);
  return { token: j2.access_token, userId, expiresAt: Date.now() + (j2.expires_in || 5184000) * 1000, permissions: perms };
}

export async function refreshToken(token) {
  if (igMock()) return { token, expiresAt: Date.now() + 60 * 86400000 };
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new IgError(`refresh ${r.status}: ${JSON.stringify(j)}`, 'Не удалось продлить доступ.');
  return { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 5184000) * 1000 };
}

async function g(token, path, params = {}) {
  const url = path.startsWith('http') ? new URL(path) : new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    const expired = e.code === 190;
    throw new IgError(`graph ${path} ${r.status}: ${e.message || ''}`, expired ? 'Доступ к Instagram истёк или отозван. Попросите клиента подключиться заново.' : `Ошибка Instagram: ${e.message || r.status}`, expired ? 'expired' : e.code);
  }
  return j;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch((e) => ({ __error: e })); }
  }));
  return out;
}

const valuesOf = (ins) => Object.fromEntries((ins?.data || []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? null]));

async function mediaInsights(token, m) {
  const isReel = m.media_product_type === 'REELS';
  const sets = isReel
    ? ['reach,saved,shares,views,total_interactions,ig_reels_avg_watch_time', 'reach,saved,shares,views', 'reach,saved']
    : ['reach,saved,shares,views,total_interactions,profile_visits', 'reach,saved,shares,views', 'reach,saved'];
  for (const metric of sets) {
    try { return valuesOf(await g(token, `/${m.id}/insights`, { metric })); } catch (e) { if (e.code === 'expired') throw e; }
  }
  return {};
}

async function storyInsights(token, s) {
  for (const metric of ['reach,views,replies,shares,navigation,follows,profile_visits', 'reach,views,replies', 'reach']) {
    try { return valuesOf(await g(token, `/${s.id}/insights`, { metric })); } catch (e) { if (e.code === 'expired') throw e; }
  }
  return {};
}

function formatOf(m) {
  if (m.media_product_type === 'REELS') return 'Reels';
  if (m.media_type === 'CAROUSEL_ALBUM') return 'Карусель';
  if (m.media_type === 'VIDEO') return 'Видео';
  return 'Фото';
}
function mediaList(m) {
  const one = (x) => (x.media_type === 'VIDEO' ? { type: 'video', url: x.media_url, poster: x.thumbnail_url || null } : { type: 'image', url: x.media_url });
  if (m.media_type === 'CAROUSEL_ALBUM' && m.children?.data?.length) return m.children.data.filter((c) => c.media_url).map(one);
  return m.media_url ? [one(m)] : [];
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeMedia(m, ins) {
  return {
    id: m.id, shortCode: null, url: m.permalink, timestamp: m.timestamp, caption: m.caption || '',
    hashtags: (m.caption || '').match(/#[\p{L}\p{N}_]+/gu)?.map((h) => h.slice(1)) || [],
    format: formatOf(m), likes: num(m.like_count), comments: num(m.comments_count),
    views: num(ins.views), reach: num(ins.reach), saved: num(ins.saved), shares: num(ins.shares),
    interactions: num(ins.total_interactions), profileVisits: num(ins.profile_visits),
    avgWatchMs: num(ins.ig_reels_avg_watch_time), duration: null, isPinned: false,
    thumb: m.thumbnail_url || m.media_url || null, media: mediaList(m), latestComments: [],
  };
}

export async function fetchProfile(token) {
  if (igMock()) return MOCK.profile();
  const p = await g(token, '/me', { fields: 'user_id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,account_type,website' });
  return {
    username: p.username, fullName: p.name || '', biography: p.biography || '', externalUrl: p.website || null,
    followers: num(p.followers_count), following: num(p.follows_count), postsCount: num(p.media_count),
    avatar: p.profile_picture_url || null, accountType: p.account_type || null, verified: false, isPrivate: false, category: null,
  };
}

// Posts newer than sinceMs, with insights. refreshSinceMs: posts older than this keep their stored insights.
export async function fetchMedia(token, { sinceMs, refreshSinceMs, known = new Map(), limit = 300 }) {
  if (igMock()) return MOCK.media(sinceMs);
  const fields = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{media_type,media_url,thumbnail_url}';
  let page = await g(token, '/me/media', { fields, limit: 50 });
  const items = [];
  while (page) {
    for (const m of page.data || []) {
      if (Date.parse(m.timestamp) < sinceMs) { page = null; break; }
      items.push(m);
    }
    if (!page || items.length >= limit || !page.paging?.next) break;
    page = await g(token, page.paging.next);
  }
  return pool(items, 5, async (m) => {
    const old = known.get(m.id);
    const fresh = !old || Date.parse(m.timestamp) >= refreshSinceMs;
    const ins = fresh ? await mediaInsights(token, m) : { views: old.views, reach: old.reach, saved: old.saved, shares: old.shares, total_interactions: old.interactions, profile_visits: old.profileVisits, ig_reels_avg_watch_time: old.avgWatchMs };
    return normalizeMedia(m, ins);
  }).then((list) => list.filter((x) => x && !x.__error));
}

// Live stories (only the last 24 h exist in the API) with insights.
export async function fetchStories(token) {
  if (igMock()) return MOCK.stories();
  const page = await g(token, '/me/stories', { fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp' });
  const list = await pool(page.data || [], 5, async (s) => {
    const ins = await storyInsights(token, s);
    let nav = ins.navigation;
    return {
      id: s.id, timestamp: s.timestamp, url: s.permalink || null, mediaType: s.media_type,
      media: s.media_url ? (s.media_type === 'VIDEO' ? { type: 'video', url: s.media_url, poster: s.thumbnail_url || null } : { type: 'image', url: s.media_url }) : null,
      thumb: s.thumbnail_url || s.media_url || null,
      reach: num(ins.reach), views: num(ins.views), replies: num(ins.replies), shares: num(ins.shares),
      navigation: num(nav), follows: num(ins.follows), profileVisits: num(ins.profile_visits),
    };
  });
  return list.filter((x) => x && !x.__error);
}

// Daily account metrics for the last `days` (API allows up to 30 per request).
export async function fetchDaily(token, days = 30) {
  if (igMock()) return MOCK.daily(days);
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86400;
  const out = {};
  for (const metric of ['reach', 'follower_count']) {
    try {
      const j = await g(token, '/me/insights', { metric, period: 'day', since, until });
      for (const v of j.data?.[0]?.values || []) {
        const d = new Date(Date.parse(v.end_time) - 86400000).toISOString().slice(0, 10);
        (out[d] ||= {})[metric === 'reach' ? 'reach' : 'newFollowers'] = num(v.value);
      }
    } catch (e) { if (e.code === 'expired') throw e; }
  }
  return out;
}

// ---------------- mock ----------------
function rng(seed) { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const MOCK = {
  profile: () => ({ username: 'client.studio', fullName: 'Client Studio', biography: 'Тестовый клиент · подключён через Instagram', externalUrl: null, followers: 12840, following: 380, postsCount: 214, avatar: '/mock-media/avatar-client.svg', accountType: 'BUSINESS', verified: false, isPrivate: false, category: null }),
  media(sinceMs) {
    const r = rng('ig-media'); const out = []; let t = Date.now() - 4 * 3600000; let i = 0;
    const titles = ['Ваша цена — не повод извиняться', '5 фраз вместо «мне неудобно»', 'Один разговор всё изменил', 'Что стоит за «дорого»', 'Как попросить о помощи', 'Три вопроса клиенту'];
    while (t > sinceMs && i < 80) {
      const k = r(); const prod = k < 0.5 ? 'REELS' : 'FEED'; const type = k < 0.5 ? 'VIDEO' : k < 0.8 ? 'CAROUSEL_ALBUM' : 'IMAGE';
      const reach = Math.round((2500 + r() * 9000) * (r() < 0.1 ? 3 : 1)); const title = titles[i % titles.length];
      const img = (n) => `/mock-media/ig${i}-${n}.svg?t=${encodeURIComponent(title)}&f=${type}`;
      const m = { id: 'igm' + i, media_type: type, media_product_type: prod, permalink: `https://www.instagram.com/p/IGMOCK${i}/`, timestamp: new Date(t).toISOString(), caption: `${title}\n\nТестовый пост клиента.\n\nСохраните, чтобы вернуться.\n\n#переговоры`, like_count: Math.round(reach * 0.06), comments_count: Math.round(reach * 0.006), media_url: img(1), thumbnail_url: img(1), children: type === 'CAROUSEL_ALBUM' ? { data: [1, 2, 3].map((n) => ({ media_type: 'IMAGE', media_url: img(n) })) } : null };
      out.push(normalizeMedia(m, { reach, views: Math.round(reach * (prod === 'REELS' ? 1.9 : 1.3)), saved: Math.round(reach * (0.01 + r() * 0.03)), shares: Math.round(reach * (0.004 + r() * 0.02)), total_interactions: Math.round(reach * 0.09), profile_visits: Math.round(reach * 0.01), ig_reels_avg_watch_time: prod === 'REELS' ? 4000 + Math.round(r() * 9000) : null }));
      t -= (0.8 + r() * 2.5) * 86400000; i++;
    }
    return out;
  },
  stories() {
    const r = rng('ig-stories-' + new Date().toISOString().slice(0, 13)); const n = 2 + Math.floor(r() * 4); const out = []; let v = 1800 + Math.round(r() * 800);
    for (let k = 0; k < n; k++) { out.push({ id: `igs-${new Date().toISOString().slice(0, 10)}-${k}`, timestamp: new Date(Date.now() - (n - k) * 2 * 3600000).toISOString(), url: null, mediaType: 'IMAGE', media: { type: 'image', url: `/mock-media/st${k}-1.svg?t=Stories%20${k + 1}&f=STORY` }, thumb: `/mock-media/st${k}-1.svg?t=Stories%20${k + 1}&f=STORY`, reach: Math.round(v * 0.9), views: v, replies: Math.round(r() * 15), shares: Math.round(r() * 6), navigation: Math.round(v * 0.8), follows: Math.round(r() * 4), profileVisits: Math.round(r() * 20) }); v = Math.round(v * (0.8 + r() * 0.12)); }
    return out;
  },
  daily(days) {
    const r = rng('ig-daily'); const out = {};
    for (let d = 1; d <= days; d++) { const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10); out[date] = { reach: Math.round(4000 + r() * 6000), newFollowers: Math.round(5 + r() * 40) }; }
    return out;
  },
};
// Mock history of past stories so the calendar has something to show.
export function mockStoryHistory(days = 60) {
  const r = rng('ig-story-history'); const out = [];
  for (let d = 1; d <= days; d++) {
    if (r() < 0.4) continue;
    const n = 1 + Math.floor(r() * 5); let v = 1500 + Math.round(r() * 1500);
    for (let k = 0; k < n; k++) { const ts = new Date(Date.now() - d * 86400000 + k * 3 * 3600000).toISOString(); out.push({ id: `igsh-${d}-${k}`, timestamp: ts, url: null, mediaType: 'IMAGE', media: null, thumb: null, reach: Math.round(v * 0.9), views: v, replies: Math.round(r() * 12), shares: Math.round(r() * 5), navigation: Math.round(v * 0.8), follows: Math.round(r() * 3), profileVisits: Math.round(r() * 15), final: true }); v = Math.round(v * (0.78 + r() * 0.15)); }
  }
  return out;
}

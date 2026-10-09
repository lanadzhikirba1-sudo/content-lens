// Offline test data in the same shape Apify's Instagram actors return.
// Enabled with APIFY_MOCK=1 — lets you run the whole site without spending Apify credits.

function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  'Ваша цена — не повод извиняться', '5 фраз вместо «мне неудобно»', 'Один разговор всё изменил',
  'Не соглашаться — нормально', 'Что стоит за «дорого»', 'Подготовка к встрече за 20 минут',
  'Как попросить о помощи', 'Три вопроса клиенту', 'Разговор без сценария', 'Как отказать и сохранить отношения',
  'Почему клиенты пропадают после цены', 'Мой худший созвон и чему он научил', 'Пауза — сильнее аргумента',
  'Чек-лист перед переговорами', 'Как говорить о деньгах спокойно', 'Границы с клиентами: 4 правила',
  'Что делать, если торгуются', 'История одного «нет»', 'Как я поднимала цены', 'Ошибки в первом письме',
];
const CTAS = ['Сохраните, чтобы вернуться к этому.', 'Напишите «план» в директ — пришлю шаблон.', 'Поделитесь с тем, кому это нужно.', 'А как у вас? Расскажите в комментариях.'];
const BODY = 'Перед важным разговором полезно понять, какого результата вы хотите. Сформулируйте просьбу и оставьте пространство для ответа.';
const TAGS = ['переговоры', 'границы', 'личное', 'продажи', 'фриланс'];

export const FOLLOWERS_NOW = (handle) => 9000 + Math.floor(rng(handle)() * 8000);

export function mockProfileItems(handle) {
  if (handle === 'private.test') return [{ username: handle, private: true, followersCount: 120 }];
  if (handle === 'notfound.test') return [{ error: 'not_found', errorDescription: 'Profile does not exist' }];
  return [{
    username: handle,
    fullName: handle.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    biography: 'Переговоры без стресса · консультации\nПишу о деньгах, границах и клиентах',
    externalUrl: 'https://example.com',
    followersCount: FOLLOWERS_NOW(handle),
    followsCount: 412,
    postsCount: 318,
    profilePicUrlHD: `/mock-media/avatar-${handle}.svg`,
    verified: false,
    private: false,
    isBusinessAccount: true,
    businessCategoryName: 'Коуч',
  }];
}

export function mockPostItems(handle, { since, limit }) {
  const r = rng(handle + ':posts');
  const now = Date.now();
  const minTs = /^\d{4}-\d{2}-\d{2}$/.test(since || '') ? Date.parse(since) : now - 183 * 86400000;
  const items = [];
  let t = now - 3600000 * 5;
  let i = 0;
  while (t > minTs && items.length < limit) {
    const kind = r();
    const type = kind < 0.5 ? 'Video' : kind < 0.82 ? 'Sidecar' : 'Image';
    const id = `${handle.length}${100000 + i}`;
    const title = TITLES[i % TITLES.length];
    const tag = TAGS[Math.floor(r() * TAGS.length)];
    const base = 120 + r() * 380;
    const viral = r() < 0.12 ? 3 + r() * 4 : 1;
    const likes = Math.round(base * viral * (type === 'Video' ? 1.3 : 1));
    const slides = type === 'Sidecar' ? 2 + Math.floor(r() * 5) : 1;
    const media = (n) => `/mock-media/${id}-${n}.svg?t=${encodeURIComponent(title)}&f=${type}`;
    items.push({
      id,
      type,
      productType: type === 'Video' ? 'clips' : type === 'Sidecar' ? 'carousel_container' : 'feed',
      shortCode: 'MOCK' + id,
      url: `https://www.instagram.com/p/MOCK${id}/`,
      caption: `${title}\n\n${BODY}\n\n${CTAS[i % CTAS.length]}\n\n#${tag} #${TAGS[(i + 2) % TAGS.length]}`,
      hashtags: [tag, TAGS[(i + 2) % TAGS.length]],
      commentsCount: Math.round(likes * (0.03 + r() * 0.08)),
      likesCount: r() < 0.04 ? -1 : likes,
      videoPlayCount: type === 'Video' ? Math.round(likes * (14 + r() * 20)) : undefined,
      videoViewCount: type === 'Video' ? Math.round(likes * 9) : undefined,
      videoDuration: type === 'Video' ? 12 + Math.round(r() * 50) : undefined,
      timestamp: new Date(t).toISOString(),
      displayUrl: media(1),
      videoUrl: null,
      childPosts: type === 'Sidecar' ? Array.from({ length: slides }, (_, k) => ({ type: 'Image', displayUrl: media(k + 1) })) : [],
      latestComments: Array.from({ length: Math.min(4, 1 + Math.floor(r() * 4)) }, (_, k) => ({
        ownerUsername: ['anna.k', 'mike_sales', 'olga.pro', 'dmitry.b'][k], text: ['Очень полезно, спасибо!', 'Сохранила 🙌', 'А если клиент молчит неделю?', 'Жиза'][k],
        timestamp: new Date(t + (k + 1) * 3600000).toISOString(),
      })),
      isPinned: i === 3,
      ownerUsername: handle,
    });
    t -= (0.6 + r() * 2.6) * 86400000;
    i++;
  }
  return items;
}

// Follower history that a real deployment accumulates one sync per day.
export function mockSnapshots(handle, days = 120) {
  const now = FOLLOWERS_NOW(handle);
  const r = rng(handle + ':snap');
  const out = [];
  let f = now;
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    out.push({ date, followers: f, following: 412, postsCount: 318 });
    f -= Math.round(5 + r() * 25 - 6);
  }
  return out.reverse();
}

export function mockMediaSvg(name, title = '', format = '') {
  const avatar = name.startsWith('avatar-');
  if (avatar) {
    const letter = name.slice(7, 8).toUpperCase();
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e6e1ed"/><text x="80" y="104" text-anchor="middle" font-family="Georgia" font-size="72" fill="#4b3d5c">${letter}</text></svg>`;
  }
  const slide = name.split('-').pop();
  const palette = ['#e1dbe7', '#e7e3d9', '#dce6e0', '#dce0eb'];
  const bg = palette[name.length % 4];
  const words = title.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) { if ((cur + ' ' + w).length > 18) { lines.push(cur); cur = w; } else cur += (cur ? ' ' : '') + w; }
  lines.push(cur);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="750"><rect width="600" height="750" fill="${bg}"/><text x="48" y="72" font-family="Arial" font-size="20" fill="#66546f">Тестовые данные · ${esc(format)} · ${esc(slide)}</text>${lines.map((l, k) => `<text x="48" y="${250 + k * 60}" font-family="Georgia" font-size="46" fill="#34293e">${esc(l)}</text>`).join('')}</svg>`;
}

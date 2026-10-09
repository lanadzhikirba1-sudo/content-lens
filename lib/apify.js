// Apify client: runs Instagram actors and returns dataset items.
// Uses the async run + poll flow so long runs are not cut off by the 300 s sync limit.
import { mockProfileItems, mockPostItems } from './mock.js';

const BASE = 'https://api.apify.com/v2';
const PROFILE_ACTOR = process.env.APIFY_PROFILE_ACTOR || 'apify~instagram-profile-scraper';
const POSTS_ACTOR = process.env.APIFY_POSTS_ACTOR || 'apify~instagram-scraper';
const RUN_TIMEOUT_MS = Number(process.env.APIFY_RUN_TIMEOUT_SEC || 600) * 1000;

export const isMock = () => process.env.APIFY_MOCK === '1' || process.env.APIFY_MOCK === 'true';

export class ApifyError extends Error {
  constructor(message, userMessage) { super(message); this.userMessage = userMessage || message; }
}

async function call(pathname, { method = 'GET', body } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new ApifyError('APIFY_TOKEN is not set', 'Сервер не настроен: не задан APIFY_TOKEN.');
  const res = await fetch(BASE + pathname, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300) || res.statusText;
    const user = res.status === 401 ? 'Apify отклонил токен. Проверьте APIFY_TOKEN.'
      : res.status === 402 || /credit|usage|limit/i.test(msg) ? 'На аккаунте Apify закончились кредиты или достигнут лимит.'
      : `Ошибка Apify (${res.status}).`;
    throw new ApifyError(`Apify ${res.status}: ${msg}`, user);
  }
  return json;
}

// Start an actor run, wait for it to finish, return dataset items.
export async function runActor(actor, input) {
  const started = Date.now();
  let run = (await call(`/acts/${actor}/runs?waitForFinish=60`, { method: 'POST', body: input })).data;
  while (['READY', 'RUNNING'].includes(run.status)) {
    if (Date.now() - started > RUN_TIMEOUT_MS) {
      await call(`/actor-runs/${run.id}/abort`, { method: 'POST' }).catch(() => {});
      throw new ApifyError(`Run ${run.id} timed out`, 'Apify не успел собрать данные. Попробуйте ещё раз.');
    }
    run = (await call(`/actor-runs/${run.id}?waitForFinish=60`)).data;
  }
  if (run.status !== 'SUCCEEDED') {
    throw new ApifyError(`Run ${run.id} finished with ${run.status}`, `Запуск Apify завершился со статусом ${run.status}.`);
  }
  return call(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json`);
}

export async function fetchProfile(handle) {
  if (isMock()) { await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS ?? 2500))); return mockProfileItems(handle); }
  return runActor(PROFILE_ACTOR, { usernames: [handle], resultsLimit: 1 });
}

// since: 'YYYY-MM-DD' or relative ('6 months'); limit: max posts.
export async function fetchPosts(handle, { since, limit }) {
  if (isMock()) return mockPostItems(handle, { since, limit });
  return runActor(POSTS_ACTOR, {
    directUrls: [`https://www.instagram.com/${handle}/`],
    resultsType: 'posts',
    resultsLimit: limit,
    onlyPostsNewerThan: since,
    addParentData: false,
    searchLimit: 1,
  });
}

// content lens — loader (Railway Function). Serves the app stored on the volume (DATA_DIR/app.mjs) and lets the owner upload a new build at /__upload.
// Upload rules: the very first upload needs no token; later uploads need UPLOAD_TOKEN,
// or happen inside a short window set by UPLOAD_OPEN_UNTIL (unix ms) in the service variables.
import express from 'express@4';
import nodemailer from 'nodemailer@6';
(globalThis as any).__express = express;
(globalThis as any).__nodemailer = nodemailer;

const DIR = Bun.env.DATA_DIR || '/data';
const APP = DIR + '/app.mjs';
const PORT = Number(Bun.env.PORT || 8080);
const INNER = 3001;
const TOKEN = Bun.env.UPLOAD_TOKEN || '';
const OPEN_UNTIL = Number(Bun.env.UPLOAD_OPEN_UNTIL || 0);
const windowOpen = () => OPEN_UNTIL > Date.now() && OPEN_UNTIL - Date.now() < 3600000; // never longer than 1 h
let loaded = false;

async function load() {
  if (loaded || !(await Bun.file(APP).exists())) return;
  process.env.PORT = String(INNER);
  await import(APP);
  loaded = true;
}
await load().catch((e) => console.error('app load failed:', e));

const page = (msg = '') => new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>content lens · upload</title><body style="font:15px system-ui;padding:24px;max-width:420px"><h2>content lens · загрузка кода</h2><p>${msg}</p><form method="post" enctype="multipart/form-data" action="/__upload">${loaded && !windowOpen() ? '<p><input name="token" type="password" placeholder="UPLOAD_TOKEN" required style="width:100%;padding:8px"></p>' : ''}<p><input name="file" type="file" required></p><button style="padding:8px 16px">Загрузить</button></form></body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });

Bun.serve({
  port: PORT,
  maxRequestBodySize: 5 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/__upload') {
      if (req.method !== 'POST') return page(loaded ? (windowOpen() ? 'Окно обновления открыто.' : 'Приложение запущено. Для новой версии нужен UPLOAD_TOKEN.') : 'Приложение ещё не загружено.');
      const form = await req.formData();
      const firstUpload = !loaded && !(await Bun.file(APP).exists());
      if (!firstUpload && !windowOpen() && (!TOKEN || form.get('token') !== TOKEN)) return page('Неверный токен.');
      const file = form.get('file');
      if (!(file instanceof Blob) || file.size < 1000) return page('Файл не выбран.');
      await Bun.write(APP, file);
      console.log(`new app uploaded: ${file.size} bytes`);
      if (loaded) { setTimeout(() => process.exit(1), 300); return page('Загружено. Перезапуск — обновите страницу через минуту.'); }
      try { await load(); return page('Загружено и запущено. <a href="/">Открыть сайт</a>'); } catch (e) { return page('Ошибка запуска: ' + String(e)); }
    }
    if (url.pathname === '/healthz' && !loaded) return new Response('loader ok');
    if (!loaded) return new Response(null, { status: 302, headers: { location: '/__upload' } });
    return fetch(`http://127.0.0.1:${INNER}${url.pathname}${url.search}`, {
      method: req.method, headers: req.headers, body: req.body, redirect: 'manual', decompress: false,
    } as any);
  },
});
console.log(`loader on :${PORT}, app ${loaded ? 'running' : 'not uploaded yet'}`);

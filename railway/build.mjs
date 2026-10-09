// Builds railway/dist/app.mjs: the whole app (server + gzipped public assets) in one file for the Railway Function loader.
// express and nodemailer come from the loader via globalThis (see shims/), so the bundle has no npm imports.
// Usage: node railway/build.mjs   (from the project root, needs network for npx esbuild)
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'), P = path.join(ROOT, 'public'), OUT = path.join(HERE, 'dist');
const ESBUILD = ['-y', 'esbuild@0.24.0'];
const min = (f) => execFileSync('npx', [...ESBUILD, f, '--minify'], { maxBuffer: 1e8 }).toString();
const html = fs.readFileSync(path.join(P, 'index.html'), 'utf8')
  .replace('/vendor/lucide.min.js', 'https://cdn.jsdelivr.net/npm/lucide@0.469.0/dist/umd/lucide.min.js')
  .replace('/vendor/d3.min.js', 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js');
const file = (f) => fs.readFileSync(path.join(P, f));
const assets = {
  '/': ['text/html; charset=utf-8', html], '/index.html': ['text/html; charset=utf-8', html],
  '/app.js': ['application/javascript; charset=utf-8', min(path.join(P, 'app.js'))],
  '/base.css': ['text/css; charset=utf-8', min(path.join(P, 'base.css'))],
  '/app.css': ['text/css; charset=utf-8', min(path.join(P, 'app.css'))],
  '/sw.js': ['application/javascript; charset=utf-8', min(path.join(P, 'sw.js'))],
  '/manifest.webmanifest': ['application/manifest+json', file('manifest.webmanifest').toString('utf8')],
  '/icon-192.png': ['image/png', file('icon-192.png')], '/icon-512.png': ['image/png', file('icon-512.png')],
  '/icon-maskable-512.png': ['image/png', file('icon-maskable-512.png')], '/apple-touch-icon.png': ['image/png', file('apple-touch-icon.png')],
};
const embedded = {};
for (const [k, [type, c]] of Object.entries(assets)) embedded[k] = { type, b64: zlib.gzipSync(c, { level: 9 }).toString('base64') };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'assets.js'), 'globalThis.__CL_ASSETS=' + JSON.stringify(embedded) + ';');
fs.writeFileSync(path.join(OUT, 'entry.js'), `import './assets.js';\nimport ${JSON.stringify(path.join(ROOT, 'server.js'))};\n`);
execFileSync('npx', [...ESBUILD, path.join(OUT, 'entry.js'), '--bundle', '--platform=node', '--format=esm', '--minify',
  `--alias:express=${path.join(HERE, 'shims/express.js')}`, `--alias:nodemailer=${path.join(HERE, 'shims/nodemailer.js')}`,
  `--outfile=${path.join(OUT, 'app.mjs')}`], { stdio: 'inherit' });
fs.rmSync(path.join(OUT, 'assets.js')); fs.rmSync(path.join(OUT, 'entry.js'));
console.log('railway/dist/app.mjs', fs.statSync(path.join(OUT, 'app.mjs')).size, 'bytes');

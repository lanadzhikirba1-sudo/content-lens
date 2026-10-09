// Tiny JSON-file store. Good for a single instance; swap for a DB when scaling out.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.db = { users: {}, accounts: {}, annotations: {} };
    if (fs.existsSync(this.file)) {
      try { this.db = { ...this.db, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (e) {
        console.error('db.json is unreadable, starting empty:', e.message);
      }
    }
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  user(email) {
    if (!this.db.users[email]) this.db.users[email] = { email, handle: null, createdAt: new Date().toISOString() };
    return this.db.users[email];
  }

  account(handle) {
    if (!this.db.accounts[handle]) {
      this.db.accounts[handle] = { handle, profile: null, posts: [], snapshots: [], sync: { status: 'idle' } };
    }
    return this.db.accounts[handle];
  }

  annotations(handle) {
    if (!this.db.annotations[handle]) this.db.annotations[handle] = {};
    return this.db.annotations[handle];
  }

  // Persistent secret for signing session cookies when SESSION_SECRET is not provided.
  secret() {
    const f = path.join(this.dir, '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, cryptoRandom());
    return fs.readFileSync(f, 'utf8');
  }
}

function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

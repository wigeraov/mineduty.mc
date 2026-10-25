process.env.BCRYPT_COST = '4';
process.env.FLOOD_SECONDS = '0';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mdf-test-' + process.pid);
const bcrypt = require('bcryptjs');
const { open } = require('../src/db');
const { createApp } = require('../src/app');

async function start(opts = {}) {
  const db = open(':memory:');
  const app = createApp(db, { writeLimit: 10000, authLimit: 10000, ...opts });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => server.close() };
}
function mkUser(db, name, role = 'user', pw = 'password-123') {
  const now = Date.now();
  const id = db.prepare('INSERT INTO users(username,email,pass_hash,created_at,updated_at,last_seen,email_verified) VALUES(?,?,?,?,?,?,1)').run(name, name.toLowerCase() + '@t.test', bcrypt.hashSync(pw, 4), now, now, now).lastInsertRowid;
  db.prepare("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE key IN ('user',?)").run(id, role);
  return id;
}
// Клиент с cookie-jar и автоматическим CSRF
class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const res = await fetch(this.base + path, { method, redirect: 'manual', headers: { cookie: this.cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }, body: body ? new URLSearchParams(body).toString() : undefined });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const [kv] = c.split(';'); const [k] = kv.split('='); this.cookie = this.cookie.split('; ').filter(x => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    res.text_ = await res.text();
    return res;
  }
  get(p) { return this.req('GET', p); }
  async token() { const r = await this.get('/'); return (r.text_.match(/name="csrf" content="([^"]+)"/) || [])[1]; }
  async post(p, body = {}, withCsrf = true) { return this.req('POST', p, withCsrf ? { _csrf: await this.token(), ...body } : body); }
  async login(login, password = 'password-123') { return this.post('/login', { login, password }); }
}
module.exports = { start, mkUser, Client };

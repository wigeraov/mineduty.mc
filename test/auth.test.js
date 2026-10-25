const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, mkUser, Client } = require('./helper');
let S; before(async () => { S = await start(); }); after(() => S.close());

test('регистрация: валидация, уникальность, хеш пароля', async () => {
  const c = new Client(S.base);
  let r = await c.post('/register', { username: 'ab', email: 'bad', password: '123', password2: '123' });
  assert.equal(r.status, 400);
  r = await c.post('/register', { username: 'Steve', email: 'steve@t.test', password: 'strong-pass-1', password2: 'strong-pass-1' });
  assert.equal(r.status, 302);
  const u = S.db.prepare('SELECT * FROM users WHERE username=?').get('Steve');
  assert.ok(u.pass_hash.startsWith('$2'), 'bcrypt-хеш');
  assert.notEqual(u.pass_hash, 'strong-pass-1');
  const role = S.db.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?').all(u.id).map(x => x.key);
  assert.deepEqual(role, ['user'], 'новый пользователь получает только роль user');
  const c2 = new Client(S.base);
  r = await c2.post('/register', { username: 'steve', email: 'other@t.test', password: 'strong-pass-1', password2: 'strong-pass-1' });
  assert.equal(r.status, 400, 'логин уникален без учёта регистра');
  r = await c2.post('/register', { username: 'Steve2', email: 'STEVE@t.test', password: 'strong-pass-1', password2: 'strong-pass-1' });
  assert.equal(r.status, 400, 'email уникален');
});

test('нельзя выбрать роль при регистрации', async () => {
  const c = new Client(S.base);
  await c.post('/register', { username: 'Hacker', email: 'h@t.test', password: 'strong-pass-1', password2: 'strong-pass-1', role: 'founder', role_id: '5', roles: 'founder' });
  const roles = S.db.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE u.username=?').all('Hacker').map(x => x.key);
  assert.deepEqual(roles, ['user']);
});

test('вход, выход и CSRF', async () => {
  mkUser(S.db, 'Alice');
  const c = new Client(S.base);
  assert.equal((await c.post('/login', { login: 'Alice', password: 'password-123' }, false)).status, 403, 'без CSRF-токена отказ');
  assert.equal((await c.login('Alice', 'wrong-password')).status, 401);
  assert.equal((await c.login('Alice')).status, 302);
  assert.match((await c.get('/')).text_, /Alice/);
  await c.post('/logout');
  assert.doesNotMatch((await c.get('/')).text_, /\/settings/);
});

test('блокировка аккаунта после 5 неверных паролей', async () => {
  mkUser(S.db, 'Bob');
  const c = new Client(S.base);
  for (let i = 0; i < 5; i++) await c.login('Bob', 'bad-password-' + i);
  const r = await c.login('Bob');
  assert.equal(r.status, 429, 'даже верный пароль не принимается во время блокировки');
});

test('бан закрывает вход и обрывает сессию', async () => {
  const id = mkUser(S.db, 'Eve'), mod = mkUser(S.db, 'Boss', 'admin');
  const c = new Client(S.base); await c.login('Eve');
  S.db.prepare("INSERT INTO bans(user_id,issuer_id,type,reason,expires_at,created_at) VALUES(?,?,'ban','test',NULL,?)").run(id, mod, Date.now());
  assert.doesNotMatch((await c.get('/')).text_, /\/settings/, 'сессия забаненного не действует');
  assert.equal((await new Client(S.base).login('Eve')).status, 403);
});

test('сброс пароля: токен одноразовый, ответ не раскрывает email', async () => {
  mkUser(S.db, 'Carol');
  const c = new Client(S.base);
  const a = await c.post('/forgot', { email: 'carol@t.test' }), b = await c.post('/forgot', { email: 'nobody@t.test' });
  assert.equal(a.status, 200); assert.equal(a.text_.length > 0, true); assert.equal(a.status, b.status);
  const crypto = require('crypto'), tok = 'a'.repeat(64);
  S.db.prepare("UPDATE users SET token_hash=?,token_kind='reset',token_expires=? WHERE username='Carol'").run(crypto.createHash('sha256').update(tok).digest('hex'), Date.now() + 60000);
  assert.equal((await c.post('/reset/' + tok, { password: 'new-password-1', password2: 'new-password-1' })).status, 302);
  assert.equal((await c.post('/reset/' + tok, { password: 'another-pass-1', password2: 'another-pass-1' })).status, 400, 'повторное использование токена невозможно');
  assert.equal((await new Client(S.base).login('Carol', 'new-password-1')).status, 302);
});

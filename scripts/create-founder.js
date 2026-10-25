// Безопасное создание первого основателя: пароль вводится скрытно и нигде не сохраняется в открытом виде.
// Использование: npm run create-founder   (интерактивно)
// Не интерактивно: FOUNDER_USERNAME=.. FOUNDER_EMAIL=.. FOUNDER_PASSWORD=.. npm run create-founder
const readline = require('readline');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { open } = require('../src/db');

function ask(q, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); }; }
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}
(async () => {
  const db = open();
  const username = process.env.FOUNDER_USERNAME || await ask('Логин основателя: ');
  const email = process.env.FOUNDER_EMAIL || await ask('Email: ');
  const password = process.env.FOUNDER_PASSWORD || await ask('Пароль (минимум 12 символов): ', true);
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('Логин: 3–20 символов, латиница, цифры, _');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Некорректный email');
  if (password.length < 12) throw new Error('Пароль основателя должен быть не короче 12 символов');
  if (db.prepare('SELECT 1 FROM users WHERE username=? OR email=?').get(username, email)) throw new Error('Такой логин или email уже существует');
  const now = Date.now();
  db.transaction(() => {
    const id = db.prepare('INSERT INTO users(username,email,pass_hash,created_at,updated_at,last_seen,email_verified) VALUES(?,?,?,?,?,?,1)').run(username, email, bcrypt.hashSync(password, config.bcryptCost), now, now, now).lastInsertRowid;
    db.prepare("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE key IN ('user','founder')").run(id);
    db.prepare("INSERT INTO audit_log(actor_name,action,target,level,created_at) VALUES('system','founder.create',?,2,?)").run(username, now);
  })();
  console.log(`Готово: основатель «${username}» создан. Войдите на форум и смените остальные настройки в /admin.`);
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });

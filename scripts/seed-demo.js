// Демо-данные для локальной проверки. Пароли генерируются случайно и выводятся один раз.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { open } = require('../src/db');
if (config.isProd) { console.error('seed-demo запрещён в production'); process.exit(1); }
const db = open(), now = Date.now();
const users = [['ModAnna', 'moderator'], ['HelperMax', 'helper'], ['Steve_228', 'user'], ['Alex_Miner', 'user']];
for (const [name, role] of users) {
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(name)) continue;
  const pw = crypto.randomBytes(9).toString('base64url');
  const id = db.prepare('INSERT INTO users(username,email,pass_hash,created_at,updated_at,last_seen,email_verified) VALUES(?,?,?,?,?,?,1)').run(name, name.toLowerCase() + '@example.test', bcrypt.hashSync(pw, config.bcryptCost), now, now, now).lastInsertRowid;
  db.prepare("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE key IN ('user',?)").run(id, role);
  console.log(`${name} (${role}) пароль: ${pw}`);
}
const admin = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const mk = (sid, uid, title, body) => { const t = db.prepare('INSERT INTO threads(section_id,user_id,title,created_at,last_post_at,last_user_id) VALUES(?,?,?,?,?,?)').run(sid, uid, title, now, now, uid).lastInsertRowid; db.prepare('INSERT INTO posts(thread_id,user_id,body,created_at) VALUES(?,?,?,?)').run(t, uid, body, now); db.prepare('UPDATE users SET thread_count=thread_count+1,post_count=post_count+1 WHERE id=?').run(uid); };
const sec = t => db.prepare('SELECT id FROM sections WHERE title=?').get(t).id, u = n => db.prepare('SELECT id FROM users WHERE username=?').get(n).id;
if (!db.prepare('SELECT 1 FROM threads').get()) {
  mk(sec('Новости проекта'), admin.id, 'ОТКРЫТИЕ УЖЕ В ЭТУ СУББОТУ: ANARCHY HARD', 'Друзья! Стартует первый сервер MineDuty. Анархия, ваниль и настоящий хардкор.');
  mk(sec('Правила проекта'), admin.id, 'Правила проекта', '1. Читы, X-ray и дюпы запрещены.\n2. PvP и гриферство разрешены.\n3. Реклама других серверов запрещена.');
  mk(sec('Жалобы на игроков'), u('Alex_Miner'), 'Жалоба на Creeper_Killer: X-ray', 'Копал прямо к алмазам, скриншоты есть.');
  mk(sec('Вопросы и помощь'), u('Steve_228'), 'Как защитить базу от гриферов?', 'Подскажите, как лучше ставить приваты?');
}
console.log('Демо-данные добавлены.');

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { PERMS, ROLE_PERMS } = require('./perms');

const SCHEMA = `
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 pass_hash TEXT NOT NULL, avatar TEXT, cover TEXT, about TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 last_seen INTEGER, post_count INTEGER NOT NULL DEFAULT 0, thread_count INTEGER NOT NULL DEFAULT 0,
 pm_privacy TEXT NOT NULL DEFAULT 'everyone', show_online INTEGER NOT NULL DEFAULT 1, email_verified INTEGER NOT NULL DEFAULT 0,
 failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, token_hash TEXT, token_kind TEXT, token_expires INTEGER,
 last_post_at INTEGER NOT NULL DEFAULT 0, last_pm_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE roles(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL, is_staff INTEGER NOT NULL DEFAULT 0);
CREATE TABLE permissions(key TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE role_permissions(role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, perm TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE, PRIMARY KEY(role_id, perm));
CREATE TABLE user_roles(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(user_id, role_id));
CREATE TABLE categories(id INTEGER PRIMARY KEY, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sections(id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 icon TEXT NOT NULL DEFAULT '💬', position INTEGER NOT NULL DEFAULT 0, view_min INTEGER NOT NULL DEFAULT 0, post_min INTEGER NOT NULL DEFAULT 10, thread_min INTEGER NOT NULL DEFAULT 10, solvable INTEGER NOT NULL DEFAULT 0);
CREATE TABLE threads(id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', pinned INTEGER NOT NULL DEFAULT 0, solved INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, last_post_at INTEGER NOT NULL, last_user_id INTEGER REFERENCES users(id));
CREATE INDEX idx_threads_section ON threads(section_id, pinned DESC, last_post_at DESC);
CREATE INDEX idx_threads_user ON threads(user_id);
CREATE TABLE posts(id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL,
 created_at INTEGER NOT NULL, edited_at INTEGER, edited_by INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_posts_thread ON posts(thread_id, id);
CREATE INDEX idx_posts_user ON posts(user_id);
CREATE TABLE reactions(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(post_id, user_id));
CREATE TABLE notifications(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, text TEXT NOT NULL, url TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX idx_notif_user ON notifications(user_id, read, id DESC);
CREATE TABLE conversations(id INTEGER PRIMARY KEY, user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, updated_at INTEGER NOT NULL, UNIQUE(user_a, user_b), CHECK(user_a < user_b));
CREATE TABLE private_messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_pm_conv ON private_messages(conversation_id, id);
CREATE TABLE reports(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, reporter_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', handled_by INTEGER REFERENCES users(id), note TEXT, created_at INTEGER NOT NULL, handled_at INTEGER);
CREATE INDEX idx_reports_status ON reports(status, id DESC);
CREATE TABLE warnings(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE bans(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL CHECK(type IN ('ban','mute')),
 reason TEXT NOT NULL, expires_at INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX idx_bans_user ON bans(user_id, active);
CREATE TABLE achievements(key TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT NOT NULL, description TEXT NOT NULL);
CREATE TABLE user_achievements(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL REFERENCES achievements(key) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, key));
CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor_id INTEGER, actor_name TEXT, action TEXT NOT NULL, target TEXT, details TEXT, level INTEGER NOT NULL DEFAULT 1, ip TEXT, created_at INTEGER NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE news(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
CREATE TABLE sessions(sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
`;

const DEFAULT_SETTINGS = {
  site_name: 'MineDuty', tagline: 'Форум Minecraft-сервера · анархия и ваниль', server_ip: 'mc.mineduty.fun',
  discord: 'https://discord.gg/6ymxG9DBFN', vk: 'https://vk.ru/club241966105', youtube: 'https://www.youtube.com/@minedutyminecraft',
  registration_open: '1', accent: '#ef3030',
};
const ACHIEVEMENTS = [
  ['first_post', 'Первое слово', '💬', 'Написал первое сообщение'],
  ['posts_100', 'Болтун', '🗣️', '100 сообщений на форуме'],
  ['first_thread', 'Основатель темы', '📌', 'Создал первую тему'],
  ['liked_10', 'Любимчик', '❤️', 'Получил 10 реакций'],
  ['veteran_30', 'Ветеран', '🏅', '30 дней на форуме'],
];
const STRUCTURE = [
  ['Информация о проекте', [
    ['Новости проекта', 'Анонсы, ивенты и открытие серверов', '📰', 0, 10, 30, 0],
    ['Правила проекта', 'Что можно и нельзя на MineDuty', '📜', 0, 10, 40, 0],
    ['Обновления', 'Список изменений и патчноуты', '🔧', 0, 10, 30, 0]]],
  ['Игровые разделы', [
    ['Жалобы на игроков', 'Читы, X-ray, дюпы и другие нарушения', '🚨', 0, 10, 10, 0],
    ['Жалобы на администрацию', 'Если вы не согласны с решением персонала', '⚖️', 0, 10, 10, 0],
    ['Заявления на пост', 'Хотите стать хелпером или модератором?', '🛡️', 0, 10, 10, 0],
    ['Вопросы и помощь', 'Спросите — вам помогут', '❓', 0, 10, 10, 1]]],
  ['Сообщество', [
    ['Общение', 'Всё, что не вошло в другие разделы', '💬', 0, 10, 10, 0],
    ['Предложения', 'Ваши идеи для сервера', '💡', 0, 10, 10, 0],
    ['Обсуждения', 'Кланы, союзы, тактика и торговля', '⚔️', 0, 10, 10, 0]]],
  ['Администрация', [
    ['Раздел для персонала', 'Только для хелперов и выше', '🔒', 20, 20, 20, 0],
    ['Архив заявлений', 'Закрытые заявления и обращения', '🗄️', 20, 20, 30, 0],
    ['Внутренние обсуждения', 'Только для модераторов и выше', '🧩', 30, 30, 30, 0]]],
];

function seedBase(db) {
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [k, l] of Object.entries(PERMS)) db.prepare('INSERT OR IGNORE INTO permissions(key,label) VALUES(?,?)').run(k, l);
    if (!db.prepare('SELECT 1 FROM roles LIMIT 1').get()) {
      for (const r of config.roles) {
        const id = db.prepare('INSERT INTO roles(key,name,color,icon,priority,is_staff) VALUES(?,?,?,?,?,?)').run(r.key, r.name, r.color, r.icon, r.priority, r.is_staff).lastInsertRowid;
        for (const p of ROLE_PERMS[r.key]) db.prepare('INSERT INTO role_permissions(role_id,perm) VALUES(?,?)').run(id, p);
      }
    }
    // Новые разрешения, добавленные в код, получают только основатели (безопасный дефолт).
    const f = db.prepare("SELECT id FROM roles WHERE key='founder'").get();
    if (f) for (const k of Object.keys(PERMS)) db.prepare('INSERT OR IGNORE INTO role_permissions(role_id,perm) VALUES(?,?)').run(f.id, k);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
    for (const a of ACHIEVEMENTS) db.prepare('INSERT OR IGNORE INTO achievements(key,title,icon,description) VALUES(?,?,?,?)').run(...a);
    if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
      STRUCTURE.forEach(([title, secs], ci) => {
        const cid = db.prepare('INSERT INTO categories(title,position) VALUES(?,?)').run(title, ci).lastInsertRowid;
        secs.forEach(([t, d, ic, vm, pm, tm, sv], si) => db.prepare('INSERT INTO sections(category_id,title,description,icon,position,view_min,post_min,thread_min,solvable) VALUES(?,?,?,?,?,?,?,?,?)').run(cid, t, d, ic, si, vm, pm, tm, sv));
      });
    }
  });
  tx();
}

function open(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode=WAL');
  db.pragma('foreign_keys=ON');
  if (db.pragma('user_version', { simple: true }) < 1) { db.exec(SCHEMA); db.pragma('user_version=1'); }
  seedBase(db);
  return db;
}
module.exports = { open };

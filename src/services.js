const { userRoles } = require('./perms');
const now = () => Date.now();

function notify(db, userId, type, text, url, exceptId) {
  if (!userId || userId === exceptId) return;
  db.prepare('INSERT INTO notifications(user_id,type,text,url,created_at) VALUES(?,?,?,?,?)').run(userId, type, text.slice(0, 200), url, now());
}
function audit(db, actor, action, target, details = '', level = 1, ip = '') {
  db.prepare('INSERT INTO audit_log(actor_id,actor_name,action,target,details,level,ip,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(actor ? actor.id : null, actor ? actor.username : 'system', action, String(target ?? ''), String(details).slice(0, 500), level, ip, now());
}
function award(db, uid) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!u) return;
  const likes = db.prepare('SELECT COUNT(*) c FROM reactions r JOIN posts p ON p.id=r.post_id WHERE p.user_id=?').get(uid).c;
  const checks = { first_post: u.post_count >= 1, posts_100: u.post_count >= 100, first_thread: u.thread_count >= 1, liked_10: likes >= 10, veteran_30: now() - u.created_at > 30 * 86400000 };
  for (const [k, ok] of Object.entries(checks)) if (ok && db.prepare('INSERT OR IGNORE INTO user_achievements(user_id,key,created_at) VALUES(?,?,?)').run(uid, k, now()).changes)
    notify(db, uid, 'award', `Новая награда: ${db.prepare('SELECT title FROM achievements WHERE key=?').get(k).title}`, `/u/${u.username}?tab=awards`);
}
function activeSanction(db, uid, type) {
  return db.prepare('SELECT * FROM bans WHERE user_id=? AND type=? AND active=1 AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC').get(uid, type, now());
}
// Роли пачкой для списка пользователей: {userId: [role,...]} (первая — главная, определяет цвет ника)
function rolesMap(db, ids) {
  const map = {};
  for (const id of new Set(ids.filter(Boolean))) map[id] = userRoles(db, id);
  return map;
}
module.exports = { notify, audit, award, activeSanction, rolesMap, now };

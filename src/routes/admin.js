const express = require('express');
const U = require('../util');
const { requireAuth, requirePerm } = require('../mw');
const { PERMS, canManageUser, userPerms, userRoles } = require('../perms');
const { audit, notify, rolesMap, now } = require('../services');

module.exports = app => {
  const db = app.locals.db, r = express.Router();
  r.use(requireAuth, requirePerm('admin.access'));
  r.use((req, res, next) => { res.locals.adminPath = req.path; next(); });
  const toArr = v => (Array.isArray(v) ? v : v ? [v] : []);
  const back = (req, res, url, ok, err) => { if (err) req.flash('err', err); else if (ok) req.flash('ok', ok); res.redirect(url); };
  const DURATIONS = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, perm: null };
  const target = (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
    if (!u) { res.status(404).render('error', { code: 404, message: 'Пользователь не найден.' }); return null; }
    u.roles = userRoles(db, u.id); u.perms = userPerms(db, u.id); u.priority = u.roles[0] ? u.roles[0].priority : 0;
    return u;
  };

  // ---------- Главная ----------
  r.get('/', (req, res) => {
    const c = sql => db.prepare(sql).get().c;
    const stats = {
      users: c('SELECT COUNT(*) c FROM users'), threads: c('SELECT COUNT(*) c FROM threads'), posts: c('SELECT COUNT(*) c FROM posts WHERE deleted=0'),
      reports: c("SELECT COUNT(*) c FROM reports WHERE status='open'"), bans: c("SELECT COUNT(*) c FROM bans WHERE active=1 AND type='ban' AND (expires_at IS NULL OR expires_at>" + now() + ')'),
      mutes: c("SELECT COUNT(*) c FROM bans WHERE active=1 AND type='mute' AND (expires_at IS NULL OR expires_at>" + now() + ')'),
      new7: db.prepare('SELECT COUNT(*) c FROM users WHERE created_at>?').get(now() - 7 * 86400e3).c,
    };
    const maxLevel = req.me.perms.has('audit.view_all') ? 2 : 1;
    const log = req.me.perms.has('audit.view') ? db.prepare('SELECT * FROM audit_log WHERE level<=? ORDER BY id DESC LIMIT 8').all(maxLevel) : [];
    res.render('admin/dashboard', { title: 'Панель управления', stats, log });
  });

  // ---------- Пользователи ----------
  const anyPerm = (...ps) => (req, res, next) => ps.some(p => req.me.perms.has(p)) ? next() : res.status(403).render('error', { code: 403, message: 'Недостаточно прав.' });
  const userAccess = anyPerm('user.manage', 'warn.issue', 'user.mute');
  r.get('/users', userAccess, (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 40), role = String(req.query.role || ''), sort = { new: 'u.id DESC', posts: 'u.post_count DESC', seen: 'u.last_seen DESC' }[req.query.sort] || 'u.id DESC';
    const w = ["(u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')"], a = [`%${U.likeEsc(q)}%`, `%${U.likeEsc(q)}%`];
    if (role) { w.push('EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.key=?)'); a.push(role); }
    const pg = U.pager(req.query.page, db.prepare(`SELECT COUNT(*) c FROM users u WHERE ${w.join(' AND ')}`).get(...a).c, 25);
    const users = db.prepare(`SELECT u.* FROM users u WHERE ${w.join(' AND ')} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...a, pg.per, pg.offset);
    res.render('admin/users', { title: 'Пользователи', users, pg, q, role, sort: req.query.sort || 'new', roles: db.prepare('SELECT * FROM roles ORDER BY priority DESC').all(), rm: rolesMap(db, users.map(u => u.id)) });
  });
  r.get('/users/:id', userAccess, (req, res) => {
    const u = target(req, res); if (!u) return;
    res.render('admin/user', { title: u.username, u, allRoles: db.prepare('SELECT * FROM roles ORDER BY priority DESC').all(),
      warnings: db.prepare('SELECT w.*, i.username issuer FROM warnings w JOIN users i ON i.id=w.issuer_id WHERE w.user_id=? ORDER BY w.id DESC').all(u.id),
      bans: db.prepare('SELECT b.*, i.username issuer FROM bans b JOIN users i ON i.id=b.issuer_id WHERE b.user_id=? ORDER BY b.id DESC').all(u.id),
      manageable: canManageUser(req.me, u), DURATIONS });
  });
  const guard = (perm) => (req, res, next) => {
    if (!req.me.perms.has(perm)) return res.status(403).render('error', { code: 403, message: 'Недостаточно прав.' });
    const u = target(req, res); if (!u) return;
    if (!canManageUser(req.me, u)) return res.status(403).render('error', { code: 403, message: 'Нельзя применять это действие к себе или к пользователю с равной/более высокой ролью.' });
    req.target = u; next();
  };
  const roleAllowed = role => req => req.me.perms.has('role.manage') || role.priority < req.me.priority;
  r.post('/users/:id/role', guard('role.assign'), (req, res) => {
    const u = req.target, role = db.prepare('SELECT * FROM roles WHERE id=?').get(+req.body.role_id), url = '/admin/users/' + u.id;
    if (!role || !roleAllowed(role)(req)) return back(req, res, url, null, 'Эту роль вы назначать не можете.');
    if (req.body.op === 'remove') {
      if (role.key === 'founder' && db.prepare("SELECT COUNT(*) c FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.key='founder'").get().c <= 1) return back(req, res, url, null, 'Нельзя снять роль с единственного основателя.');
      db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=?').run(u.id, role.id);
      if (!db.prepare('SELECT 1 FROM user_roles WHERE user_id=?').get(u.id)) db.prepare("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE key='user'").run(u.id);
    } else db.prepare('INSERT OR IGNORE INTO user_roles(user_id,role_id) VALUES(?,?)').run(u.id, role.id);
    audit(db, req.me, req.body.op === 'remove' ? 'role.remove' : 'role.assign', `user#${u.id} ${u.username}`, role.name, 2, req.ip);
    back(req, res, url, 'Роли обновлены.');
  });
  const reasonOf = req => String(req.body.reason || '').trim().slice(0, 300);
  r.post('/users/:id/warn', guard('warn.issue'), (req, res) => {
    const u = req.target, reason = reasonOf(req), url = '/admin/users/' + u.id;
    if (reason.length < 5) return back(req, res, url, null, 'Укажите причину (от 5 символов).');
    db.prepare('INSERT INTO warnings(user_id,issuer_id,reason,created_at) VALUES(?,?,?,?)').run(u.id, req.me.id, reason, now());
    notify(db, u.id, 'warning', `Вы получили предупреждение: ${reason}`, `/u/${u.username}`);
    audit(db, req.me, 'warn.issue', `user#${u.id} ${u.username}`, reason, 1, req.ip);
    back(req, res, url, 'Предупреждение выдано.');
  });
  for (const [route, type, perm] of [['mute', 'mute', 'user.mute'], ['ban', 'ban', 'user.ban']])
    r.post(`/users/:id/${route}`, guard(perm), (req, res) => {
      const u = req.target, reason = reasonOf(req), url = '/admin/users/' + u.id, d = req.body.duration;
      if (reason.length < 5) return back(req, res, url, null, 'Укажите причину (от 5 символов).');
      if (!(d in DURATIONS)) return back(req, res, url, null, 'Выберите срок.');
      if (type === 'mute' && d === 'perm') return back(req, res, url, null, 'Мут выдаётся на срок до 30 дней.');
      db.prepare('INSERT INTO bans(user_id,issuer_id,type,reason,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(u.id, req.me.id, type, reason, DURATIONS[d] ? now() + DURATIONS[d] : null, now());
      if (type === 'ban') db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.uid')=?").run(u.id);
      else notify(db, u.id, 'warning', `Вам выдан мут: ${reason}`, `/u/${u.username}`);
      audit(db, req.me, 'user.' + type, `user#${u.id} ${u.username}`, `${d}: ${reason}`, 2, req.ip);
      back(req, res, url, type === 'ban' ? 'Аккаунт заблокирован.' : 'Мут выдан.');
    });
  r.post('/sanctions/:id/revoke', (req, res) => {
    const b = db.prepare('SELECT * FROM bans WHERE id=?').get(+req.params.id);
    if (!b) return res.status(404).render('error', { code: 404, message: 'Не найдено.' });
    if (!req.me.perms.has(b.type === 'ban' ? 'user.ban' : 'user.mute')) return res.status(403).render('error', { code: 403, message: 'Недостаточно прав.' });
    db.prepare('UPDATE bans SET active=0 WHERE id=?').run(b.id);
    audit(db, req.me, 'user.un' + b.type, `user#${b.user_id}`, b.reason, 2, req.ip);
    back(req, res, req.body.back && req.body.back.startsWith('/admin/') ? req.body.back : '/admin/sanctions', 'Санкция снята.');
  });
  r.get('/sanctions', requirePerm('warn.issue'), (req, res) => {
    const bans = db.prepare('SELECT b.*, u.username, i.username issuer FROM bans b JOIN users u ON u.id=b.user_id JOIN users i ON i.id=b.issuer_id ORDER BY b.active DESC, b.id DESC LIMIT 100').all();
    const warnings = db.prepare('SELECT w.*, u.username, i.username issuer FROM warnings w JOIN users u ON u.id=w.user_id JOIN users i ON i.id=w.issuer_id ORDER BY w.id DESC LIMIT 100').all();
    res.render('admin/sanctions', { title: 'Блокировки и предупреждения', bans, warnings, now: now() });
  });

  // ---------- Роли, цвета и права ----------
  r.get('/roles', requirePerm('role.manage'), (req, res) => {
    const roles = db.prepare('SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id=r.id) members FROM roles r ORDER BY priority DESC').all();
    for (const x of roles) x.perms = new Set(db.prepare('SELECT perm FROM role_permissions WHERE role_id=?').all(x.id).map(p => p.perm));
    res.render('admin/roles', { title: 'Роли и цвета никнеймов', roles, PERMS });
  });
  r.post('/roles/new', requirePerm('role.manage'), (req, res) => {
    const { key = '', name = '', color = '', icon = '', priority = '' } = req.body, p = parseInt(priority, 10);
    if (!/^[a-z0-9_]{2,20}$/.test(key) || !name.trim() || name.length > 30 || !U.HEX.test(color) || !(p >= 1 && p <= 99) || icon.length > 8) return back(req, res, '/admin/roles', null, 'Проверьте поля: ключ (a-z, 0-9, _), название, цвет #RRGGBB, приоритет 1–99.');
    if (db.prepare('SELECT 1 FROM roles WHERE key=?').get(key)) return back(req, res, '/admin/roles', null, 'Такой ключ уже существует.');
    db.prepare('INSERT INTO roles(key,name,color,icon,priority,is_staff) VALUES(?,?,?,?,?,?)').run(key, name.trim(), color, icon.trim(), p, req.body.is_staff ? 1 : 0);
    audit(db, req.me, 'role.create', key, name, 2, req.ip);
    back(req, res, '/admin/roles', 'Группа создана. Теперь настройте её права.');
  });
  r.post('/roles/:id', requirePerm('role.manage'), (req, res) => {
    const role = db.prepare('SELECT * FROM roles WHERE id=?').get(+req.params.id);
    if (!role) return res.status(404).render('error', { code: 404, message: 'Роль не найдена.' });
    if (req.body.op === 'delete') {
      if (['user', 'founder'].includes(role.key)) return back(req, res, '/admin/roles', null, 'Системную роль удалить нельзя.');
      db.transaction(() => { db.prepare("INSERT OR IGNORE INTO user_roles(user_id,role_id) SELECT ur.user_id,(SELECT id FROM roles WHERE key='user') FROM user_roles ur WHERE ur.role_id=?").run(role.id); db.prepare('DELETE FROM roles WHERE id=?').run(role.id); })();
      audit(db, req.me, 'role.delete', role.key, role.name, 2, req.ip);
      return back(req, res, '/admin/roles', 'Роль удалена, её участники стали пользователями.');
    }
    const { name = '', color = '', icon = '', priority = '' } = req.body, p = parseInt(priority, 10);
    if (!name.trim() || name.length > 30 || !U.HEX.test(color) || icon.length > 8 || !(p >= 1 && p <= 99)) return back(req, res, '/admin/roles', null, 'Проверьте название, цвет (#RRGGBB) и приоритет (1–99).');
    db.transaction(() => {
      db.prepare('UPDATE roles SET name=?,color=?,icon=?,priority=?,is_staff=? WHERE id=?').run(name.trim(), color, icon.trim(), role.key === 'founder' ? role.priority : p, req.body.is_staff ? 1 : 0, role.id);
      if (role.key !== 'founder') { // права основателя неизменны: защита от потери доступа
        db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(role.id);
        for (const k of toArr(req.body.perms)) if (PERMS[k]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_id,perm) VALUES(?,?)').run(role.id, k);
      }
    })();
    audit(db, req.me, 'role.update', role.key, `${name} ${color}`, 2, req.ip);
    back(req, res, '/admin/roles', 'Роль обновлена — изменения уже видны на всём форуме.');
  });

  // ---------- Категории и разделы ----------
  r.get('/categories', requirePerm('category.manage'), (req, res) => {
    const cats = db.prepare('SELECT * FROM categories ORDER BY position,id').all();
    for (const c of cats) c.sections = db.prepare('SELECT * FROM sections WHERE category_id=? ORDER BY position,id').all(c.id);
    res.render('admin/categories', { title: 'Категории и разделы', cats, roles: db.prepare('SELECT * FROM roles ORDER BY priority').all() });
  });
  const L = (v, max) => String(v || '').trim().slice(0, max), N = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  r.post('/categories/new', requirePerm('category.manage'), (req, res) => {
    const t = L(req.body.title, 80); if (t.length < 2) return back(req, res, '/admin/categories', null, 'Название от 2 символов.');
    db.prepare('INSERT INTO categories(title,position) VALUES(?,?)').run(t, N(req.body.position, 99)); audit(db, req.me, 'category.create', t, '', 1, req.ip);
    back(req, res, '/admin/categories', 'Категория создана.');
  });
  r.post('/categories/:id', requirePerm('category.manage'), (req, res) => {
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(+req.params.id); if (!c) return back(req, res, '/admin/categories', null, 'Не найдено.');
    if (req.body.op === 'delete') { db.prepare('DELETE FROM categories WHERE id=?').run(c.id); audit(db, req.me, 'category.delete', c.title, 'вместе с разделами и темами', 2, req.ip); return back(req, res, '/admin/categories', 'Категория удалена.'); }
    db.prepare('UPDATE categories SET title=?,position=? WHERE id=?').run(L(req.body.title, 80) || c.title, N(req.body.position, c.position), c.id);
    back(req, res, '/admin/categories', 'Сохранено.');
  });
  r.post('/sections/new', requirePerm('category.manage'), (req, res) => {
    const b = req.body, cat = db.prepare('SELECT id FROM categories WHERE id=?').get(+b.category_id), t = L(b.title, 80);
    if (!cat || t.length < 2) return back(req, res, '/admin/categories', null, 'Выберите категорию и укажите название.');
    db.prepare('INSERT INTO sections(category_id,title,description,icon,position) VALUES(?,?,?,?,?)').run(cat.id, t, L(b.description, 200), L(b.icon, 8) || '💬', N(b.position, 99));
    audit(db, req.me, 'section.create', t, '', 1, req.ip); back(req, res, '/admin/categories', 'Раздел создан. Настройте доступ в его карточке.');
  });
  r.post('/sections/:id', requirePerm('category.manage'), (req, res) => {
    const s = db.prepare('SELECT * FROM sections WHERE id=?').get(+req.params.id); if (!s) return back(req, res, '/admin/categories', null, 'Не найдено.');
    if (req.body.op === 'delete') { db.prepare('DELETE FROM sections WHERE id=?').run(s.id); audit(db, req.me, 'section.delete', s.title, 'вместе с темами', 2, req.ip); return back(req, res, '/admin/categories', 'Раздел удалён.'); }
    const b = req.body, lv = v => Math.min(Math.max(N(v, 0), 0), 99);
    db.prepare('UPDATE sections SET title=?,description=?,icon=?,position=?,view_min=?,post_min=?,thread_min=?,solvable=?,category_id=COALESCE((SELECT id FROM categories WHERE id=?),category_id) WHERE id=?')
      .run(L(b.title, 80) || s.title, L(b.description, 200), L(b.icon, 8) || s.icon, N(b.position, s.position), lv(b.view_min), lv(b.post_min), lv(b.thread_min), b.solvable ? 1 : 0, +b.category_id || 0, s.id);
    audit(db, req.me, 'section.update', s.title, `просмотр≥${b.view_min}`, 1, req.ip); back(req, res, '/admin/categories', 'Раздел обновлён.');
  });

  // ---------- Жалобы ----------
  r.get('/reports', requirePerm('report.handle'), (req, res) => {
    const status = ['open', 'resolved', 'rejected'].includes(req.query.status) ? req.query.status : 'open';
    const pg = U.pager(req.query.page, db.prepare('SELECT COUNT(*) c FROM reports WHERE status=?').get(status).c, 20);
    const items = db.prepare(`SELECT rp.*, p.body, p.thread_id, p.user_id author_id, t.title, a.username author, rr.username reporter, h.username handler FROM reports rp
      JOIN posts p ON p.id=rp.post_id JOIN threads t ON t.id=p.thread_id JOIN users a ON a.id=p.user_id JOIN users rr ON rr.id=rp.reporter_id LEFT JOIN users h ON h.id=rp.handled_by
      WHERE rp.status=? ORDER BY rp.id DESC LIMIT ? OFFSET ?`).all(status, pg.per, pg.offset);
    res.render('admin/reports', { title: 'Жалобы', items, pg, status });
  });
  r.post('/reports/:id', requirePerm('report.handle'), (req, res) => {
    const rp = db.prepare('SELECT * FROM reports WHERE id=?').get(+req.params.id), st = req.body.status;
    if (!rp || rp.status !== 'open' || !['resolved', 'rejected'].includes(st)) return back(req, res, '/admin/reports', null, 'Жалоба уже обработана или не найдена.');
    const note = L(req.body.note, 300);
    db.prepare('UPDATE reports SET status=?,handled_by=?,note=?,handled_at=? WHERE id=?').run(st, req.me.id, note, now(), rp.id);
    notify(db, rp.reporter_id, 'report', `Ваша жалоба ${st === 'resolved' ? 'рассмотрена' : 'отклонена'}${note ? ': ' + note : ''}`, '/');
    audit(db, req.me, 'report.' + st, `report#${rp.id}`, note, 1, req.ip);
    back(req, res, '/admin/reports', 'Жалоба обработана, автор уведомлён.');
  });

  // ---------- Сообщения (удалённые) ----------
  r.get('/content', requirePerm('post.delete_any'), (req, res) => {
    const deleted = db.prepare('SELECT p.id,p.body,p.thread_id,p.edited_at,u.username,t.title,d.username deleter FROM posts p JOIN users u ON u.id=p.user_id JOIN threads t ON t.id=p.thread_id LEFT JOIN users d ON d.id=p.edited_by WHERE p.deleted=1 ORDER BY p.edited_at DESC LIMIT 50').all();
    const threads = db.prepare('SELECT t.id,t.title,t.status,t.pinned,t.replies,t.created_at,u.username,s.title st FROM threads t JOIN users u ON u.id=t.user_id JOIN sections s ON s.id=t.section_id ORDER BY t.id DESC LIMIT 30').all();
    res.render('admin/content', { title: 'Темы и сообщения', deleted, threads });
  });
  r.post('/posts/:id/restore', requirePerm('post.delete_any'), (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id=? AND deleted=1').get(+req.params.id); if (!p) return back(req, res, '/admin/content', null, 'Не найдено.');
    db.transaction(() => { db.prepare('UPDATE posts SET deleted=0 WHERE id=?').run(p.id); db.prepare('UPDATE threads SET replies=replies+1 WHERE id=?').run(p.thread_id); db.prepare('UPDATE users SET post_count=post_count+1 WHERE id=?').run(p.user_id); })();
    audit(db, req.me, 'post.restore', `post#${p.id}`, '', 1, req.ip); back(req, res, '/admin/content', 'Сообщение восстановлено.');
  });

  // ---------- Новости ----------
  r.get('/news', requirePerm('news.manage'), (req, res) => res.render('admin/news', { title: 'Новости форума', items: db.prepare('SELECT n.*, u.username FROM news n JOIN users u ON u.id=n.author_id ORDER BY n.id DESC LIMIT 50').all() }));
  r.post('/news', requirePerm('news.manage'), (req, res) => {
    if (req.body.op === 'delete') { db.prepare('DELETE FROM news WHERE id=?').run(+req.body.id); audit(db, req.me, 'news.delete', req.body.id, '', 1, req.ip); return back(req, res, '/admin/news', 'Новость удалена.'); }
    const t = L(req.body.title, 120), b = L(req.body.body, 2000);
    if (t.length < 3 || b.length < 3) return back(req, res, '/admin/news', null, 'Заполните заголовок и текст.');
    db.prepare('INSERT INTO news(title,body,author_id,created_at) VALUES(?,?,?,?)').run(t, b, req.me.id, now()); audit(db, req.me, 'news.create', t, '', 1, req.ip);
    back(req, res, '/admin/news', 'Новость опубликована на главной.');
  });

  // ---------- Внешний вид и безопасность ----------
  r.get('/settings', requirePerm('settings.manage'), (req, res) => res.render('admin/settings', { title: 'Настройки форума' }));
  r.post('/settings', requirePerm('settings.manage'), (req, res) => {
    const b = req.body, url = v => (/^https?:\/\/[^\s"'<>]{3,200}$/.test(v) ? v : '');
    if (!U.HEX.test(b.accent || '')) return back(req, res, '/admin/settings', null, 'Акцентный цвет в формате #RRGGBB.');
    const vals = { site_name: L(b.site_name, 40) || 'MineDuty', tagline: L(b.tagline, 120), server_ip: L(b.server_ip, 80), discord: url(b.discord), vk: url(b.vk), youtube: url(b.youtube), accent: b.accent, registration_open: b.registration_open ? '1' : '0' };
    for (const [k, v] of Object.entries(vals)) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, v);
    audit(db, req.me, 'settings.update', 'forum', `регистрация: ${vals.registration_open}`, 2, req.ip); back(req, res, '/admin/settings', 'Настройки сохранены.');
  });
  r.get('/logs', requirePerm('audit.view'), (req, res) => {
    const maxLevel = req.me.perms.has('audit.view_all') ? 2 : 1, q = String(req.query.q || '').trim().slice(0, 40);
    const like = `%${U.likeEsc(q)}%`, where = "level<=? AND (action LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\')";
    const pg = U.pager(req.query.page, db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE ${where}`).get(maxLevel, like, like, like).c, 40);
    const items = db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(maxLevel, like, like, like, pg.per, pg.offset);
    res.render('admin/logs', { title: 'Журнал действий', items, pg, q, full: maxLevel === 2 });
  });
  return r;
};

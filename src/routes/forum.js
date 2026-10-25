const express = require('express');
const config = require('../config');
const U = require('../util');
const { requireAuth, writeBlock, flood } = require('../mw');
const { notify, audit, award, rolesMap } = require('../services');
const KINDS = { like: '👍', fire: '🔥', gg: '🏆' };
const SORTS = { last: 't.last_post_at DESC', new: 't.created_at DESC', replies: 't.replies DESC', views: 't.views DESC' };

module.exports = app => {
  const db = app.locals.db, r = express.Router();
  const prio = me => (me ? me.priority : 0);
  const section = (id, me) => { const s = db.prepare('SELECT s.*, c.title AS cat FROM sections s JOIN categories c ON c.id=s.category_id WHERE s.id=?').get(id); return s && s.view_min <= prio(me) ? s : null; };
  const thread = (id, me) => { const t = db.prepare('SELECT t.*, s.title AS stitle, s.view_min, s.post_min, s.thread_min, s.solvable, s.id AS sid FROM threads t JOIN sections s ON s.id=t.section_id WHERE t.id=?').get(id); return t && t.view_min <= prio(me) ? t : null; };
  const notFound = res => res.status(404).render('error', { code: 404, message: 'Не найдено или нет доступа.' });
  const forbid = (res, m = 'Недостаточно прав.') => res.status(403).render('error', { code: 403, message: m });
  const inList = a => a.map(() => '?').join(',') || 'NULL';
  const authorPrio = id => { const x = db.prepare('SELECT MAX(r.priority) p FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=?').get(id); return x ? x.p || 0 : 0; };
  const outranks = (me, uid) => uid === me.id || me.priority > authorPrio(uid) || me.perms.has('role.manage');
  const canEditPost = (me, p, t) => !!me && (
    (me.perms.has('post.edit_any') && outranks(me, p.user_id)) ||
    (p.user_id === me.id && me.perms.has('post.edit_own') && t.status === 'open' && Date.now() - p.created_at < config.editWindowMs));
  const canDeletePost = (me, p, t, first) => !!me && !p.deleted && (
    (me.perms.has('post.delete_any') && outranks(me, p.user_id) && (!first || me.perms.has('thread.delete'))) ||
    (p.user_id === me.id && me.perms.has('post.delete_own') && !first && t.status === 'open' && Date.now() - p.created_at < config.editWindowMs));
  const postUrl = (tid, pid) => `/t/${tid}?p=${pid}#post-${pid}`;

  // ---------- Главная ----------
  r.get('/', (req, res) => {
    const pr = prio(req.me), now = Date.now();
    const cats = db.prepare('SELECT * FROM categories ORDER BY position,id').all();
    const secs = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM threads t WHERE t.section_id=s.id) tc,
      (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id=p.thread_id WHERE t.section_id=s.id AND p.deleted=0) pc,
      (SELECT t.id FROM threads t WHERE t.section_id=s.id ORDER BY t.last_post_at DESC LIMIT 1) last_id
      FROM sections s WHERE s.view_min<=? ORDER BY s.position,s.id`).all(pr);
    const lastIds = secs.map(s => s.last_id).filter(Boolean);
    const lasts = {};
    for (const t of db.prepare(`SELECT t.id,t.title,t.last_post_at,t.last_user_id,u.username lu FROM threads t LEFT JOIN users u ON u.id=t.last_user_id WHERE t.id IN (${inList(lastIds)})`).all(...lastIds)) lasts[t.id] = t;
    const tq = `SELECT t.*, s.title st, u.username, u.id uid FROM threads t JOIN sections s ON s.id=t.section_id JOIN users u ON u.id=t.user_id WHERE s.view_min<=?`;
    const latest = db.prepare(tq + ' ORDER BY t.last_post_at DESC LIMIT 8').all(pr);
    const popular = db.prepare(tq + ' ORDER BY (t.views + t.replies*5) DESC, t.last_post_at DESC LIMIT 5').all(pr);
    const posts = db.prepare(`SELECT p.id,p.thread_id,p.created_at,p.user_id,u.username,t.title FROM posts p JOIN threads t ON t.id=p.thread_id JOIN sections s ON s.id=t.section_id JOIN users u ON u.id=p.user_id WHERE p.deleted=0 AND s.view_min<=? ORDER BY p.id DESC LIMIT 6`).all(pr);
    const online = db.prepare('SELECT id,username FROM users WHERE last_seen>? AND show_online=1 ORDER BY last_seen DESC LIMIT 40').all(now - 300000);
    const stats = { users: db.prepare('SELECT COUNT(*) c FROM users').get().c, threads: db.prepare('SELECT COUNT(*) c FROM threads').get().c, posts: db.prepare('SELECT COUNT(*) c FROM posts WHERE deleted=0').get().c, newest: db.prepare('SELECT id,username FROM users ORDER BY id DESC LIMIT 1').get() };
    const news = db.prepare('SELECT n.*, u.username FROM news n JOIN users u ON u.id=n.author_id ORDER BY n.id DESC LIMIT 3').all();
    const rm = rolesMap(db, [...latest.map(t => t.uid), ...popular.map(t => t.uid), ...posts.map(p => p.user_id), ...online.map(u => u.id), ...Object.values(lasts).map(l => l.last_user_id), stats.newest && stats.newest.id]);
    res.render('home', { title: 'Форум', cats, secs, lasts, latest, popular, posts, online, stats, news, rm });
  });

  // ---------- Раздел ----------
  r.get('/s/:id', (req, res) => {
    const s = section(+req.params.id, req.me); if (!s) return notFound(res);
    const sort = SORTS[req.query.sort] ? req.query.sort : 'last';
    const pg = U.pager(req.query.page, db.prepare('SELECT COUNT(*) c FROM threads WHERE section_id=?').get(s.id).c, config.perPage.threads);
    const threads = db.prepare(`SELECT t.*, u.username, lu.username lname FROM threads t JOIN users u ON u.id=t.user_id LEFT JOIN users lu ON lu.id=t.last_user_id WHERE t.section_id=? ORDER BY t.pinned DESC, ${SORTS[sort]} LIMIT ? OFFSET ?`).all(s.id, pg.per, pg.offset);
    const rm = rolesMap(db, threads.flatMap(t => [t.user_id, t.last_user_id]));
    res.render('section', { title: s.title, s, threads, pg, sort, rm, canCreate: !!req.me && req.me.perms.has('thread.create') && req.me.priority >= s.thread_min });
  });

  r.get('/s/:id/new', requireAuth, (req, res) => {
    const s = section(+req.params.id, req.me); if (!s) return notFound(res);
    if (req.me.priority < s.thread_min || !req.me.perms.has('thread.create')) return forbid(res, 'В этом разделе темы создаёт только персонал.');
    res.render('compose', { title: 'Новая тема', s, t: null, post: null, errors: [], v: {}, mode: 'thread' });
  });
  r.post('/s/:id/new', requireAuth, (req, res) => {
    const s = section(+req.params.id, req.me); if (!s) return notFound(res);
    if (req.me.priority < s.thread_min || !req.me.perms.has('thread.create')) return forbid(res, 'В этом разделе темы создаёт только персонал.');
    const title = String(req.body.title || '').trim(), body = String(req.body.body || '').trim(), errors = [];
    const wb = writeBlock(req.me) || flood(req.me, config); if (wb) errors.push(wb);
    if (title.length < 3 || title.length > 120) errors.push('Заголовок: от 3 до 120 символов.');
    if (body.length < 2 || body.length > 20000) errors.push('Текст: от 2 до 20 000 символов.');
    if (errors.length) return res.status(400).render('compose', { title: 'Новая тема', s, t: null, post: null, errors, v: { title, body }, mode: 'thread' });
    const now = Date.now();
    const tid = db.transaction(() => {
      const id = db.prepare('INSERT INTO threads(section_id,user_id,title,created_at,last_post_at,last_user_id) VALUES(?,?,?,?,?,?)').run(s.id, req.me.id, title, now, now, req.me.id).lastInsertRowid;
      db.prepare('INSERT INTO posts(thread_id,user_id,body,created_at) VALUES(?,?,?,?)').run(id, req.me.id, body, now);
      db.prepare('UPDATE users SET thread_count=thread_count+1, post_count=post_count+1, last_post_at=? WHERE id=?').run(now, req.me.id);
      return id;
    })();
    for (const n of U.mentions(body)) { const m = db.prepare('SELECT id FROM users WHERE username=?').get(n); if (m) notify(db, m.id, 'mention', `${req.me.username} упомянул вас в теме «${title}»`, `/t/${tid}`, req.me.id); }
    award(db, req.me.id);
    res.redirect('/t/' + tid);
  });

  // ---------- Тема ----------
  r.get('/t/:id', (req, res) => {
    const t = thread(+req.params.id, req.me); if (!t) return notFound(res);
    const viewed = (req.session.viewed = req.session.viewed || []);
    if (!viewed.includes(t.id)) { db.prepare('UPDATE threads SET views=views+1 WHERE id=?').run(t.id); viewed.push(t.id); if (viewed.length > 100) viewed.shift(); t.views++; }
    const total = db.prepare('SELECT COUNT(*) c FROM posts WHERE thread_id=?').get(t.id).c;
    let page = req.query.page;
    if (req.query.p) page = Math.ceil(db.prepare('SELECT COUNT(*) c FROM posts WHERE thread_id=? AND id<=?').get(t.id, +req.query.p || 0).c / config.perPage.posts) || 1;
    const pg = U.pager(page, total, config.perPage.posts);
    const posts = db.prepare('SELECT p.*, u.username, u.avatar, u.created_at ucreated, u.post_count upc FROM posts p JOIN users u ON u.id=p.user_id WHERE p.thread_id=? ORDER BY p.id LIMIT ? OFFSET ?').all(t.id, pg.per, pg.offset);
    const firstId = db.prepare('SELECT MIN(id) m FROM posts WHERE thread_id=?').get(t.id).m, ids = posts.map(p => p.id);
    const rx = {}, mine = {};
    for (const x of db.prepare(`SELECT post_id,kind,COUNT(*) c FROM reactions WHERE post_id IN (${inList(ids)}) GROUP BY post_id,kind`).all(...ids)) (rx[x.post_id] = rx[x.post_id] || {})[x.kind] = x.c;
    if (req.me) for (const x of db.prepare(`SELECT post_id,kind FROM reactions WHERE user_id=? AND post_id IN (${inList(ids)})`).all(req.me.id, ...ids)) mine[x.post_id] = x.kind;
    const rm = rolesMap(db, [t.user_id, ...posts.map(p => p.user_id)]);
    for (const p of posts) { p.first = p.id === firstId; p.canEdit = canEditPost(req.me, p, t); p.canDel = canDeletePost(req.me, p, t, p.first); p.rx = rx[p.id] || {}; p.mine = mine[p.id]; }
    let replyBlock = null, canReply = false;
    if (req.me) {
      const mod = req.me.perms.has('thread.close');
      if (!req.me.perms.has('post.create')) replyBlock = 'Отвечать в темах вам запрещено.';
      else if (req.me.priority < t.post_min) replyBlock = 'В этом разделе отвечает только персонал.';
      else if (t.status !== 'open' && !mod) replyBlock = t.status === 'closed' ? 'Тема закрыта.' : 'Тема в архиве.';
      else replyBlock = writeBlock(req.me);
      canReply = !replyBlock;
    }
    let quote = '';
    if (req.query.quote) { const q = db.prepare('SELECT p.body,u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.thread_id=? AND p.deleted=0').get(+req.query.quote, t.id); if (q) quote = `[quote=${q.username}]${q.body.replace(/\[quote[\s\S]*?\[\/quote\]/gi, '').trim().slice(0, 1500)}[/quote]\n`; }
    const sections = req.me && req.me.perms.has('thread.move') ? db.prepare('SELECT id,title FROM sections WHERE view_min<=? ORDER BY title').all(req.me.priority) : [];
    res.render('thread', { title: t.title, t, posts, pg, rm, KINDS, canReply, replyBlock, quote, sections,
      canSolve: !!req.me && t.solvable && (t.user_id === req.me.id || req.me.perms.has('solve.any')) });
  });

  r.post('/t/:id/reply', requireAuth, (req, res) => {
    const t = thread(+req.params.id, req.me); if (!t) return notFound(res);
    const me = req.me, body = String(req.body.body || '').trim();
    if (!me.perms.has('post.create') || me.priority < t.post_min) return forbid(res);
    if (t.status !== 'open' && !me.perms.has('thread.close')) return forbid(res, 'Тема закрыта.');
    const wb = writeBlock(me) || flood(me, config);
    if (wb) { req.flash('err', wb); return res.redirect('/t/' + t.id); }
    if (body.length < 2 || body.length > 20000) { req.flash('err', 'Сообщение: от 2 до 20 000 символов.'); return res.redirect('/t/' + t.id); }
    const now = Date.now();
    const pid = db.transaction(() => {
      const id = db.prepare('INSERT INTO posts(thread_id,user_id,body,created_at) VALUES(?,?,?,?)').run(t.id, me.id, body, now).lastInsertRowid;
      db.prepare('UPDATE threads SET replies=replies+1,last_post_at=?,last_user_id=? WHERE id=?').run(now, me.id, t.id);
      db.prepare('UPDATE users SET post_count=post_count+1,last_post_at=? WHERE id=?').run(now, me.id);
      return id;
    })();
    const url = postUrl(t.id, pid), sent = new Set([me.id]);
    const once = (uid, type, text) => { if (uid && !sent.has(uid)) { sent.add(uid); notify(db, uid, type, text, url); } };
    for (const m of body.matchAll(/\[quote=([A-Za-z0-9_]{3,20})\]/g)) { const q = db.prepare('SELECT id FROM users WHERE username=?').get(m[1]); if (q) once(q.id, 'reply', `${me.username} ответил на ваше сообщение в теме «${t.title}»`); }
    for (const n of U.mentions(body)) { const m = db.prepare('SELECT id FROM users WHERE username=?').get(n); if (m) once(m.id, 'mention', `${me.username} упомянул вас в теме «${t.title}»`); }
    once(t.user_id, 'reply', `${me.username} ответил в вашей теме «${t.title}»`);
    award(db, me.id);
    res.redirect(url);
  });

  // ---------- Сообщения ----------
  const loadPost = (id, me) => { const p = db.prepare('SELECT * FROM posts WHERE id=?').get(id); if (!p) return {}; const t = thread(p.thread_id, me); return t ? { p, t } : {}; };
  r.get('/post/:id/edit', requireAuth, (req, res) => {
    const { p, t } = loadPost(+req.params.id, req.me); if (!p) return notFound(res);
    if (!canEditPost(req.me, p, t)) return forbid(res);
    const first = db.prepare('SELECT MIN(id) m FROM posts WHERE thread_id=?').get(t.id).m === p.id;
    res.render('compose', { title: 'Редактирование', s: { id: t.sid, title: t.stitle }, t, post: p, errors: [], v: { title: t.title, body: p.body }, mode: first ? 'edit-first' : 'edit' });
  });
  r.post('/post/:id/edit', requireAuth, (req, res) => {
    const { p, t } = loadPost(+req.params.id, req.me); if (!p) return notFound(res);
    if (!canEditPost(req.me, p, t)) return forbid(res);
    const body = String(req.body.body || '').trim(), first = db.prepare('SELECT MIN(id) m FROM posts WHERE thread_id=?').get(t.id).m === p.id;
    const title = first ? String(req.body.title || '').trim() : t.title, errors = [];
    if (body.length < 2 || body.length > 20000) errors.push('Текст: от 2 до 20 000 символов.');
    if (first && (title.length < 3 || title.length > 120)) errors.push('Заголовок: от 3 до 120 символов.');
    if (errors.length) return res.status(400).render('compose', { title: 'Редактирование', s: { id: t.sid, title: t.stitle }, t, post: p, errors, v: { title, body }, mode: first ? 'edit-first' : 'edit' });
    db.prepare('UPDATE posts SET body=?, edited_at=?, edited_by=? WHERE id=?').run(body, Date.now(), req.me.id, p.id);
    if (first) db.prepare('UPDATE threads SET title=? WHERE id=?').run(title, t.id);
    if (p.user_id !== req.me.id) audit(db, req.me, 'post.edit', `post#${p.id}`, `тема #${t.id}`, 1, req.ip);
    res.redirect(postUrl(t.id, p.id));
  });
  r.post('/post/:id/delete', requireAuth, (req, res) => {
    const { p, t } = loadPost(+req.params.id, req.me); if (!p) return notFound(res);
    const first = db.prepare('SELECT MIN(id) m FROM posts WHERE thread_id=?').get(t.id).m === p.id;
    if (!canDeletePost(req.me, p, t, first)) return forbid(res);
    db.transaction(() => {
      db.prepare('UPDATE posts SET deleted=1, edited_by=?, edited_at=? WHERE id=?').run(req.me.id, Date.now(), p.id);
      db.prepare('UPDATE threads SET replies=MAX(replies-1,0) WHERE id=?').run(t.id);
      db.prepare('UPDATE users SET post_count=MAX(post_count-1,0) WHERE id=?').run(p.user_id);
    })();
    if (p.user_id !== req.me.id) audit(db, req.me, 'post.delete', `post#${p.id}`, `автор user#${p.user_id}, тема #${t.id}`, 1, req.ip);
    req.flash('ok', 'Сообщение удалено.'); res.redirect('/t/' + t.id);
  });
  r.post('/post/:id/react', requireAuth, (req, res) => {
    const { p, t } = loadPost(+req.params.id, req.me); if (!p) return notFound(res);
    const kind = req.body.kind;
    if (!KINDS[kind] || p.user_id === req.me.id || p.deleted) return res.redirect(postUrl(t.id, p.id));
    const cur = db.prepare('SELECT kind FROM reactions WHERE post_id=? AND user_id=?').get(p.id, req.me.id);
    if (cur && cur.kind === kind) db.prepare('DELETE FROM reactions WHERE post_id=? AND user_id=?').run(p.id, req.me.id);
    else {
      db.prepare('INSERT OR REPLACE INTO reactions(post_id,user_id,kind,created_at) VALUES(?,?,?,?)').run(p.id, req.me.id, kind, Date.now());
      if (!cur) { notify(db, p.user_id, 'reaction', `${req.me.username} отреагировал ${KINDS[kind]} на ваше сообщение`, postUrl(t.id, p.id), req.me.id); award(db, p.user_id); }
    }
    res.redirect(postUrl(t.id, p.id));
  });
  r.post('/post/:id/report', requireAuth, (req, res) => {
    const { p, t } = loadPost(+req.params.id, req.me); if (!p) return notFound(res);
    if (!req.me.perms.has('report.create')) return forbid(res);
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 5 || reason.length > 500) req.flash('err', 'Опишите причину жалобы: от 5 до 500 символов.');
    else if (db.prepare("SELECT 1 FROM reports WHERE post_id=? AND reporter_id=? AND status='open'").get(p.id, req.me.id)) req.flash('err', 'Вы уже отправили жалобу на это сообщение.');
    else { db.prepare('INSERT INTO reports(post_id,reporter_id,reason,created_at) VALUES(?,?,?,?)').run(p.id, req.me.id, reason, Date.now()); req.flash('ok', 'Жалоба отправлена модераторам.'); }
    res.redirect(postUrl(t.id, p.id));
  });

  // ---------- Действия над темой ----------
  r.post('/t/:id/mod', requireAuth, (req, res) => {
    const t = thread(+req.params.id, req.me); if (!t) return notFound(res);
    const me = req.me, a = req.body.action, has = p => me.perms.has(p);
    const set = (sql, ...args) => db.prepare(sql).run(...args);
    let msg = null, level = 1;
    if (a === 'close' && has('thread.close')) { set("UPDATE threads SET status='closed' WHERE id=?", t.id); msg = 'Тема закрыта.'; }
    else if (a === 'open' && has('thread.close')) { set("UPDATE threads SET status='open' WHERE id=?", t.id); msg = 'Тема открыта.'; }
    else if (a === 'pin' && has('thread.pin')) { set('UPDATE threads SET pinned=1 WHERE id=?', t.id); msg = 'Тема закреплена.'; }
    else if (a === 'unpin' && has('thread.pin')) { set('UPDATE threads SET pinned=0 WHERE id=?', t.id); msg = 'Тема откреплена.'; }
    else if (a === 'archive' && has('thread.archive')) { set("UPDATE threads SET status='archived', pinned=0 WHERE id=?", t.id); msg = 'Тема перенесена в архив.'; }
    else if (a === 'unarchive' && has('thread.archive')) { set("UPDATE threads SET status='open' WHERE id=?", t.id); msg = 'Тема возвращена из архива.'; }
    else if (a === 'move' && has('thread.move')) {
      const to = section(+req.body.section_id, me); if (!to) return notFound(res);
      set('UPDATE threads SET section_id=? WHERE id=?', to.id, t.id); msg = `Тема перемещена в «${to.title}».`;
    } else if ((a === 'solve' || a === 'unsolve') && t.solvable && (t.user_id === me.id || has('solve.any'))) { set('UPDATE threads SET solved=? WHERE id=?', a === 'solve' ? 1 : 0, t.id); msg = a === 'solve' ? 'Тема отмечена решённой.' : 'Отметка «решено» снята.'; }
    else if (a === 'delete' && has('thread.delete')) {
      audit(db, me, 'thread.delete', `thread#${t.id}`, t.title, 2, req.ip);
      db.transaction(() => { for (const x of db.prepare('SELECT user_id, COUNT(*) c FROM posts WHERE thread_id=? AND deleted=0 GROUP BY user_id').all(t.id)) set('UPDATE users SET post_count=MAX(post_count-?,0) WHERE id=?', x.c, x.user_id); set('UPDATE users SET thread_count=MAX(thread_count-1,0) WHERE id=?', t.user_id); set('DELETE FROM threads WHERE id=?', t.id); })();
      req.flash('ok', 'Тема удалена.'); return res.redirect('/s/' + t.sid);
    } else return forbid(res);
    if (a !== 'solve' && a !== 'unsolve') audit(db, me, 'thread.' + a, `thread#${t.id}`, t.title, level, req.ip);
    req.flash('ok', msg); res.redirect('/t/' + t.id);
  });
  return r;
};

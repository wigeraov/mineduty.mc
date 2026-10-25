const express = require('express');
const config = require('../config');
const U = require('../util');
const { requireAuth, writeBlock } = require('../mw');
const { notify, award, rolesMap, now } = require('../services');

module.exports = app => {
  const db = app.locals.db, r = express.Router();
  const prio = me => (me ? me.priority : 0);
  const notFound = res => res.status(404).render('error', { code: 404, message: 'Не найдено.' });
  const isOnline = u => u.show_online && u.last_seen && Date.now() - u.last_seen < 300000;

  // ---------- Профиль ----------
  r.get('/u/:name', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.name); if (!u) return notFound(res);
    award(db, u.id);
    const roles = rolesMap(db, [u.id])[u.id], pr = prio(req.me);
    const tab = ['overview', 'posts', 'threads', 'awards'].includes(req.query.tab) ? req.query.tab : 'overview';
    const stats = { likes: db.prepare('SELECT COUNT(*) c FROM reactions r JOIN posts p ON p.id=r.post_id WHERE p.user_id=?').get(u.id).c };
    const vis = 's.view_min<=?';
    const posts = db.prepare(`SELECT p.id,p.body,p.created_at,t.id tid,t.title FROM posts p JOIN threads t ON t.id=p.thread_id JOIN sections s ON s.id=t.section_id WHERE p.user_id=? AND p.deleted=0 AND ${vis} ORDER BY p.id DESC LIMIT ?`).all(u.id, pr, tab === 'posts' ? 30 : 5);
    const threads = db.prepare(`SELECT t.id,t.title,t.created_at,t.replies,s.title st FROM threads t JOIN sections s ON s.id=t.section_id WHERE t.user_id=? AND ${vis} ORDER BY t.id DESC LIMIT ?`).all(u.id, pr, tab === 'threads' ? 30 : 5);
    const awards = db.prepare('SELECT a.*, ua.created_at got FROM user_achievements ua JOIN achievements a ON a.key=ua.key WHERE ua.user_id=? ORDER BY ua.created_at').all(u.id);
    const allAwards = tab === 'awards' ? db.prepare('SELECT * FROM achievements').all() : [];
    const canSeeSanctions = !!req.me && (req.me.id === u.id || req.me.perms.has('warn.issue') || req.me.perms.has('user.manage'));
    const warnings = canSeeSanctions ? db.prepare('SELECT w.*, i.username issuer FROM warnings w JOIN users i ON i.id=w.issuer_id WHERE w.user_id=? ORDER BY w.id DESC LIMIT 20').all(u.id) : [];
    const sanctions = canSeeSanctions ? db.prepare('SELECT b.*, i.username issuer FROM bans b JOIN users i ON i.id=b.issuer_id WHERE b.user_id=? AND b.active=1 AND (b.expires_at IS NULL OR b.expires_at>?) ORDER BY b.id DESC').all(u.id, now()) : [];
    res.render('profile', { title: u.username, u, roles, tab, stats, posts, threads, awards, allAwards, warnings, sanctions, online: isOnline(u), canSeeSanctions });
  });

  r.get('/members', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 40), like = `%${U.likeEsc(q)}%`;
    const pg = U.pager(req.query.page, db.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE ? ESCAPE '\\'").get(like).c, config.perPage.users);
    const users = db.prepare("SELECT id,username,avatar,post_count,created_at,last_seen,show_online FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY post_count DESC, id LIMIT ? OFFSET ?").all(like, pg.per, pg.offset);
    res.render('members', { title: 'Пользователи', users, pg, q, rm: rolesMap(db, users.map(u => u.id)), isOnline });
  });

  // ---------- Личные сообщения ----------
  const convWith = (a, b) => db.prepare('SELECT * FROM conversations WHERE user_a=? AND user_b=?').get(Math.min(a, b), Math.max(a, b));
  r.get('/messages', requireAuth, (req, res) => {
    const me = req.me;
    const convs = db.prepare(`SELECT c.id, c.updated_at, u.id uid, u.username, u.avatar,
      (SELECT body FROM private_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last,
      (SELECT COUNT(*) FROM private_messages WHERE conversation_id=c.id AND read=0 AND sender_id!=?) unread
      FROM conversations c JOIN users u ON u.id = CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
      WHERE c.user_a=? OR c.user_b=? ORDER BY c.updated_at DESC`).all(me.id, me.id, me.id, me.id);
    res.render('messages', { title: 'Личные сообщения', convs, rm: rolesMap(db, convs.map(c => c.uid)) });
  });
  r.get('/messages/:name', requireAuth, (req, res) => {
    const other = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.name);
    if (!other || other.id === req.me.id) return notFound(res);
    const c = convWith(req.me.id, other.id);
    let msgs = [];
    if (c) {
      db.prepare('UPDATE private_messages SET read=1 WHERE conversation_id=? AND sender_id!=?').run(c.id, req.me.id);
      msgs = db.prepare('SELECT m.*, u.username FROM private_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.id DESC LIMIT 100').all(c.id).reverse();
    }
    res.render('conversation', { title: 'Диалог с ' + other.username, other, msgs, rm: rolesMap(db, [req.me.id, other.id]) });
  });
  r.post('/messages/:name', requireAuth, (req, res) => {
    const me = req.me, other = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.name);
    if (!other || other.id === me.id) return notFound(res);
    const back = '/messages/' + encodeURIComponent(other.username), body = String(req.body.body || '').trim();
    const otherRoles = rolesMap(db, [other.id])[other.id];
    const block = !me.perms.has('pm.send') ? 'Личные сообщения вам недоступны.' : writeBlock(me)
      || (other.pm_privacy === 'nobody' && !me.roles.some(x => x.is_staff) ? 'Пользователь не принимает личные сообщения.' : null)
      || (now() - me.last_pm_at < 3000 ? 'Слишком часто. Подождите пару секунд.' : null)
      || (body.length < 1 || body.length > 5000 ? 'Сообщение: от 1 до 5000 символов.' : null);
    if (block) { req.flash('err', block); return res.redirect(back); }
    const a = Math.min(me.id, other.id), b = Math.max(me.id, other.id);
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO conversations(user_a,user_b,updated_at) VALUES(?,?,?)').run(a, b, now());
      const c = db.prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').get(a, b);
      db.prepare('INSERT INTO private_messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)').run(c.id, me.id, body, now());
      db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), c.id);
      db.prepare('UPDATE users SET last_pm_at=? WHERE id=?').run(now(), me.id);
    })();
    const url = '/messages/' + encodeURIComponent(me.username);
    if (!db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='pm' AND url=? AND read=0").get(other.id, url)) notify(db, other.id, 'pm', `Новое личное сообщение от ${me.username}`, url);
    res.redirect(back);
  });

  // ---------- Уведомления ----------
  r.get('/notifications', requireAuth, (req, res) => {
    const pg = U.pager(req.query.page, db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(req.me.id).c, 25);
    const items = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(req.me.id, pg.per, pg.offset);
    res.render('notifications', { title: 'Уведомления', items, pg });
  });
  r.post('/notifications/read', requireAuth, (req, res) => {
    db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.me.id);
    res.redirect('/notifications');
  });
  r.get('/notifications/go/:id', requireAuth, (req, res) => {
    const n = db.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').get(+req.params.id, req.me.id);
    if (!n) return notFound(res);
    db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(n.id);
    res.redirect(n.url);
  });
  r.get('/notifications/recent.json', requireAuth, (req, res) => {
    res.json(db.prepare('SELECT id,text,read,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 8').all(req.me.id).map(n => ({ ...n, when: U.ago(n.created_at), href: '/notifications/go/' + n.id })));
  });

  // ---------- Поиск ----------
  r.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80), type = ['threads', 'posts', 'users'].includes(req.query.type) ? req.query.type : 'threads';
    const sec = +req.query.section || 0, author = String(req.query.author || '').trim().slice(0, 20);
    const from = req.query.from ? Date.parse(req.query.from) : 0, to = req.query.to ? Date.parse(req.query.to) + 86399999 : 0;
    const pr = prio(req.me), like = `%${U.likeEsc(q)}%`;
    const sections = db.prepare('SELECT id,title FROM sections WHERE view_min<=? ORDER BY title').all(pr);
    let rows = [], pg = U.pager(1, 0, config.perPage.search), searched = q.length >= 2 || (type !== 'users' && author.length >= 2);
    if (searched) {
      const w = ['s.view_min<=?'], a = [pr];
      if (sec) { w.push('s.id=?'); a.push(sec); }
      if (author) { w.push("u.username LIKE ? ESCAPE '\\'"); a.push(`%${U.likeEsc(author)}%`); }
      if (from) { w.push('x.created_at>=?'); a.push(from); }
      if (to) { w.push('x.created_at<=?'); a.push(to); }
      const per = config.perPage.search;
      if (type === 'users') {
        const c = db.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE ? ESCAPE '\\'").get(like).c;
        pg = U.pager(req.query.page, c, per);
        rows = db.prepare("SELECT id,username,avatar,post_count FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY post_count DESC LIMIT ? OFFSET ?").all(like, per, pg.offset);
      } else if (type === 'threads') {
        if (q) { w.push("x.title LIKE ? ESCAPE '\\'"); a.push(like); }
        const from_ = `FROM threads x JOIN sections s ON s.id=x.section_id JOIN users u ON u.id=x.user_id WHERE ${w.join(' AND ')}`;
        pg = U.pager(req.query.page, db.prepare(`SELECT COUNT(*) c ${from_}`).get(...a).c, per);
        rows = db.prepare(`SELECT x.id,x.title,x.created_at,x.replies,u.username,s.title st ${from_} ORDER BY x.last_post_at DESC LIMIT ? OFFSET ?`).all(...a, per, pg.offset);
      } else {
        if (q) { w.push("x.body LIKE ? ESCAPE '\\'"); a.push(like); }
        w.push('x.deleted=0');
        const from_ = `FROM posts x JOIN threads t ON t.id=x.thread_id JOIN sections s ON s.id=t.section_id JOIN users u ON u.id=x.user_id WHERE ${w.join(' AND ')}`;
        pg = U.pager(req.query.page, db.prepare(`SELECT COUNT(*) c ${from_}`).get(...a).c, per);
        rows = db.prepare(`SELECT x.id,x.body,x.created_at,t.id tid,t.title,u.username,s.title st ${from_} ORDER BY x.id DESC LIMIT ? OFFSET ?`).all(...a, per, pg.offset);
      }
    }
    res.render('search', { title: 'Поиск', q, type, sec, author, from: req.query.from || '', to: req.query.to || '', sections, rows, pg, searched });
  });
  return r;
};

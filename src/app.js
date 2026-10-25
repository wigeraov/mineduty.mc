const express = require('express');
const path = require('path');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const SqliteStore = require('./store');
const U = require('./util');
const { userPerms, userRoles } = require('./perms');
const { activeSanction } = require('./services');
const mailer = require('./mailer');

function createApp(db, opts = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', config.isProd ? 1 : false);
  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.opts = opts;
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'], styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], baseUri: ["'self'"], upgradeInsecureRequests: config.isProd ? [] : null } },
    strictTransportSecurity: config.isProd,
    crossOriginEmbedderPolicy: false,
  }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1d' : 0 }));
  app.use('/uploads', express.static(config.uploadDir, { dotfiles: 'deny', index: false }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(session({
    name: 'sid', secret: config.sessionSecret, resave: false, saveUninitialized: false, store: new SqliteStore(db),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 86400000 },
  }));
  // Общий лимит на запись: защита от флуда и перебора.
  app.use(rateLimit({ windowMs: 60000, limit: opts.writeLimit || 90, skip: r => r.method === 'GET' || r.method === 'HEAD', standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).render('error', { code: 429, message: 'Слишком много запросов. Подождите минуту.' }) }));

  // Контекст запроса: текущий пользователь, CSRF, помощники для шаблонов
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = U.token();
    let me = null;
    if (req.session.uid) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.uid);
      if (u && !activeSanction(db, u.id, 'ban')) {
        u.roles = userRoles(db, u.id); u.perms = userPerms(db, u.id); u.priority = u.roles[0] ? u.roles[0].priority : 0;
        u.mute = activeSanction(db, u.id, 'mute');
        if (!u.last_seen || Date.now() - u.last_seen > 60000) db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), u.id);
        me = u;
      } else { delete req.session.uid; }
    }
    req.me = me;
    req.flash = (t, m) => { (req.session.flash = req.session.flash || []).push({ t, m }); };
    const settings = {};
    for (const r of db.prepare('SELECT key,value FROM settings').all()) settings[r.key] = r.value;
    Object.assign(res.locals, {
      me, site: settings, csrf: req.session.csrf, flash: req.session.flash || [], path: req.path, esc: U.esc, bbcode: U.bbcode, ago: U.ago, fmtDate: U.fmtDate,
      can: p => !!me && me.perms.has(p),
      sectionLink: t => { const x = db.prepare('SELECT id FROM sections WHERE title=?').get(t); return x ? '/s/' + x.id : '/'; }, title: '', smtpOn: mailer.configured(),
      unread: me ? db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(me.id).c : 0,
      unreadPm: me ? db.prepare('SELECT COUNT(*) c FROM private_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.read=0 AND m.sender_id!=? AND (c.user_a=? OR c.user_b=?)').get(me.id, me.id, me.id).c : 0,
      nick: (name, role) => `<a class="nick" style="color:${role ? role.color : '#b9b9c3'}" href="/u/${encodeURIComponent(name)}">${U.esc(name)}</a>`,
      badge: r => r ? `<span class="badge" style="--c:${r.color}">${U.esc(r.icon)} ${U.esc(r.name)}</span>` : '',
      avatar: (name, file, role, size = 48) => file
        ? `<img class="av" src="${U.esc(file)}" alt="" width="${size}" height="${size}">`
        : `<span class="av av-l" style="width:${size}px;height:${size}px;background:${role ? role.color : '#6b6b75'}">${U.esc(String(name).charAt(0).toUpperCase())}</span>`,
    });
    req.session.flash = [];
    // CSRF: все небезопасные методы, кроме multipart (его проверяют сами маршруты после разбора формы)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !(req.headers['content-type'] || '').startsWith('multipart/')) {
      const t = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
      if (!t || !U.safeEq(t, req.session.csrf)) return res.status(403).render('error', { code: 403, message: 'Сессия устарела. Обновите страницу и повторите действие.' });
    }
    next();
  });
  app.use(require('./routes/auth')(app));
  app.use(require('./routes/forum')(app));
  app.use(require('./routes/social')(app));
  app.use('/admin', require('./routes/admin')(app));
  app.use((req, res) => res.status(404).render('error', { code: 404, message: 'Страница не найдена.' }));
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).render('error', { code: 413, message: 'Файл слишком большой (максимум 3 МБ).' });
    console.error(err);
    res.status(500).render('error', { code: 500, message: 'Внутренняя ошибка. Мы уже разбираемся.' });
  });
  return app;
}
module.exports = { createApp };

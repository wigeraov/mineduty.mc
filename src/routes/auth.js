const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const U = require('../util');
const { requireAuth, safeNext, csrfOk } = require('../mw');
const { audit, activeSanction } = require('../services');
const { sendMail, configured } = require('../mailer');

// Проверка по сигнатуре файла, а не по заявленному MIME/расширению.
function sniff(b) {
  if (b.length > 12 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function saveImage(buf) {
  const ext = sniff(buf);
  if (!ext) return null;
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(config.uploadDir, name), buf, { mode: 0o644 });
  return '/uploads/' + name;
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 2 } });

module.exports = app => {
  const db = app.locals.db, r = express.Router();
  const authLimit = rateLimit({ windowMs: 15 * 60000, limit: app.locals.opts.authLimit || 30, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).render('error', { code: 429, message: 'Слишком много попыток. Попробуйте через 15 минут.' }) });
  const hash = p => bcrypt.hashSync(p, config.bcryptCost);
  const DUMMY = bcrypt.hashSync('dummy-password', config.bcryptCost);
  const issueToken = (uid, kind, ttl) => { const t = U.token(); db.prepare('UPDATE users SET token_hash=?,token_kind=?,token_expires=? WHERE id=?').run(U.sha(t), kind, Date.now() + ttl, uid); return t; };
  const login = (req, res, uid, next) => { const fl = req.session.flash; req.session.regenerate(() => { req.session.uid = uid; req.session.csrf = U.token(); req.session.flash = fl || []; res.redirect(safeNext(next)); }); };

  r.get('/register', (req, res) => req.me ? res.redirect('/') : res.render('auth/register', { title: 'Регистрация', errors: [], v: {} }));
  r.post('/register', authLimit, (req, res) => {
    const { username = '', email = '', password = '', password2 = '' } = req.body, errors = [];
    if (db.prepare("SELECT value FROM settings WHERE key='registration_open'").get().value !== '1') errors.push('Регистрация временно закрыта.');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) errors.push('Логин: 3–20 символов, латиница, цифры и _.');
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || email.length > 254) errors.push('Укажите корректный email.');
    if (password.length < 8 || password.length > 100) errors.push('Пароль: от 8 до 100 символов.');
    if (password.toLowerCase() === username.toLowerCase()) errors.push('Пароль не должен совпадать с логином.');
    if (password !== password2) errors.push('Пароли не совпадают.');
    if (!errors.length) {
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) errors.push('Этот логин уже занят.');
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) errors.push('Этот email уже зарегистрирован.');
    }
    if (errors.length) return res.status(400).render('auth/register', { title: 'Регистрация', errors, v: { username, email } });
    const now = Date.now(), verified = configured() ? 0 : 1;
    const uid = db.transaction(() => {
      const id = db.prepare('INSERT INTO users(username,email,pass_hash,created_at,updated_at,last_seen,email_verified) VALUES(?,?,?,?,?,?,?)').run(username, email, hash(password), now, now, now, verified).lastInsertRowid;
      db.prepare("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE key='user'").run(id);
      return id;
    })();
    if (!verified) sendMail({ to: email, subject: 'Подтвердите email', text: `Перейдите по ссылке: ${config.baseUrl}/verify/${issueToken(uid, 'verify', 48 * 3600000)}` }).catch(console.error);
    req.flash('ok', verified ? 'Добро пожаловать на форум!' : 'Аккаунт создан. Мы отправили письмо для подтверждения email.');
    login(req, res, uid, '/');
  });

  r.get('/verify/:t', (req, res) => {
    const u = db.prepare("SELECT id FROM users WHERE token_hash=? AND token_kind='verify' AND token_expires>?").get(U.sha(req.params.t), Date.now());
    if (u) { db.prepare('UPDATE users SET email_verified=1, token_hash=NULL, token_kind=NULL WHERE id=?').run(u.id); req.flash('ok', 'Email подтверждён.'); } else req.flash('err', 'Ссылка недействительна или устарела.');
    res.redirect('/');
  });

  r.get('/login', (req, res) => req.me ? res.redirect('/') : res.render('auth/login', { title: 'Вход', error: null, next: req.query.next || '', v: '' }));
  r.post('/login', authLimit, (req, res) => {
    const { login: id = '', password = '', next = '' } = req.body;
    const fail = (msg, code = 401) => res.status(code).render('auth/login', { title: 'Вход', error: msg, next, v: id });
    const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(id, id);
    if (u && u.locked_until > Date.now()) return fail(`Аккаунт временно заблокирован из-за неудачных попыток. Повторите через ${Math.ceil((u.locked_until - Date.now()) / 60000)} мин.`, 429);
    const ok = bcrypt.compareSync(String(password).slice(0, 100), u ? u.pass_hash : DUMMY) && !!u;
    if (!ok) {
      if (u) { const n = u.failed_logins + 1; db.prepare('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?').run(n >= 5 ? 0 : n, n >= 5 ? Date.now() + 15 * 60000 : 0, u.id); }
      return fail('Неверный логин или пароль.');
    }
    const ban = activeSanction(db, u.id, 'ban');
    if (ban) return fail(`Аккаунт заблокирован${ban.expires_at ? ' до ' + U.fmtDate(ban.expires_at) : ' навсегда'}. Причина: ${ban.reason}`, 403);
    db.prepare('UPDATE users SET failed_logins=0, locked_until=0, last_seen=? WHERE id=?').run(Date.now(), u.id);
    login(req, res, u.id, next);
  });
  r.post('/logout', (req, res) => req.session.regenerate(() => res.redirect('/')));

  r.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Восстановление пароля', done: false }));
  r.post('/forgot', authLimit, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || ''));
    if (u) sendMail({ to: u.email, subject: 'Сброс пароля', text: `Ссылка для сброса пароля (действует 1 час): ${config.baseUrl}/reset/${issueToken(u.id, 'reset', 3600000)}` }).catch(console.error);
    res.render('auth/forgot', { title: 'Восстановление пароля', done: true }); // одинаковый ответ: не раскрываем наличие email
  });
  const resetUser = t => db.prepare("SELECT id FROM users WHERE token_hash=? AND token_kind='reset' AND token_expires>?").get(U.sha(t), Date.now());
  r.get('/reset/:t', (req, res) => res.render('auth/reset', { title: 'Новый пароль', valid: !!resetUser(req.params.t), error: null }));
  r.post('/reset/:t', authLimit, (req, res) => {
    const u = resetUser(req.params.t), p = req.body.password || '';
    if (!u) return res.status(400).render('auth/reset', { title: 'Новый пароль', valid: false, error: null });
    if (p.length < 8 || p.length > 100 || p !== req.body.password2) return res.status(400).render('auth/reset', { title: 'Новый пароль', valid: true, error: 'Пароль: от 8 до 100 символов, оба поля должны совпадать.' });
    db.prepare('UPDATE users SET pass_hash=?, token_hash=NULL, token_kind=NULL, failed_logins=0, locked_until=0, updated_at=? WHERE id=?').run(hash(p), Date.now(), u.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.uid')=?").run(u.id); // завершаем все старые сессии
    req.flash('ok', 'Пароль изменён. Войдите с новым паролем.'); res.redirect('/login');
  });

  // Настройки аккаунта
  r.get('/settings', requireAuth, (req, res) => res.render('settings', { title: 'Настройки аккаунта', errors: [] }));
  r.post('/settings/password', requireAuth, authLimit, (req, res) => {
    const { current = '', password = '', password2 = '' } = req.body, u = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(req.me.id);
    const errors = [];
    if (!bcrypt.compareSync(current, u.pass_hash)) errors.push('Текущий пароль указан неверно.');
    if (password.length < 8 || password.length > 100) errors.push('Новый пароль: от 8 до 100 символов.');
    if (password !== password2) errors.push('Новые пароли не совпадают.');
    if (errors.length) return res.status(400).render('settings', { title: 'Настройки аккаунта', errors });
    db.prepare('UPDATE users SET pass_hash=?, updated_at=? WHERE id=?').run(hash(password), Date.now(), req.me.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.uid')=? AND sid!=?").run(req.me.id, req.sessionID);
    req.flash('ok', 'Пароль изменён. Остальные сессии завершены.'); res.redirect('/settings');
  });
  r.post('/settings/profile', requireAuth, (req, res) => {
    const about = String(req.body.about || '').slice(0, 500), pm = req.body.pm_privacy === 'nobody' ? 'nobody' : 'everyone';
    db.prepare('UPDATE users SET about=?, pm_privacy=?, show_online=?, updated_at=? WHERE id=?').run(about, pm, req.body.show_online ? 1 : 0, Date.now(), req.me.id);
    req.flash('ok', 'Настройки сохранены.'); res.redirect('/settings');
  });
  r.post('/settings/images', requireAuth, upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
    if (!csrfOk(req)) return res.status(403).render('error', { code: 403, message: 'Сессия устарела. Обновите страницу.' });
    const f = req.files || {}; let n = 0;
    for (const k of ['avatar', 'cover']) if (f[k] && f[k][0]) {
      const url = saveImage(f[k][0].buffer);
      if (!url) { req.flash('err', 'Допустимы только PNG, JPEG, GIF и WebP.'); return res.redirect('/settings'); }
      db.prepare(`UPDATE users SET ${k}=?, updated_at=? WHERE id=?`).run(url, Date.now(), req.me.id); n++;
    }
    req.flash(n ? 'ok' : 'err', n ? 'Изображения обновлены.' : 'Файл не выбран.'); res.redirect('/settings');
  });
  // Загрузка картинки для вставки в сообщение (AJAX)
  r.post('/upload', requireAuth, upload.single('file'), (req, res) => {
    if (!csrfOk(req)) return res.status(403).json({ error: 'csrf' });
    const url = req.file && saveImage(req.file.buffer);
    if (!url) return res.status(400).json({ error: 'Допустимы только PNG, JPEG, GIF и WebP до 3 МБ.' });
    res.json({ url });
  });
  return r;
};
module.exports.sniff = sniff;

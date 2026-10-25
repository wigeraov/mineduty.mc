const U = require('./util');
const mailer = require('./mailer');
const requireAuth = (req, res, next) => req.me ? next() : (req.flash('err', 'Войдите, чтобы продолжить.'), res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)));
const requirePerm = perm => (req, res, next) => req.me && req.me.perms.has(perm) ? next() : res.status(403).render('error', { code: 403, message: 'Недостаточно прав.' });
// Причина, по которой пользователь не может писать, либо null.
function writeBlock(me) {
  if (me.mute) return `У вас мут${me.mute.expires_at ? ' до ' + U.fmtDate(me.mute.expires_at) : ''}. Причина: ${me.mute.reason}`;
  if (mailer.configured() && !me.email_verified) return 'Подтвердите email — письмо отправлено при регистрации.';
  return null;
}
function flood(me, config) {
  if (me.perms.has('post.edit_any')) return null;
  const left = config.floodSeconds * 1000 - (Date.now() - me.last_post_at);
  return left > 0 ? `Слишком часто. Подождите ${Math.ceil(left / 1000)} с.` : null;
}
const safeNext = n => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) ? n : '/');
const csrfOk = req => { const t = (req.body && req.body._csrf) || req.headers['x-csrf-token']; return !!t && U.safeEq(t, req.session.csrf); };
module.exports = { requireAuth, requirePerm, writeBlock, flood, safeNext, csrfOk };

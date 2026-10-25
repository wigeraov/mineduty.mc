// Каталог разрешений. Все проверки выполняются на сервере.
const PERMS = {
  'thread.create': 'Создавать темы',
  'post.create': 'Отвечать в темах',
  'post.edit_own': 'Редактировать свои сообщения',
  'post.delete_own': 'Удалять свои сообщения',
  'post.edit_any': 'Редактировать любые сообщения',
  'post.delete_any': 'Удалять любые сообщения',
  'thread.close': 'Закрывать и открывать темы',
  'thread.pin': 'Закреплять темы',
  'thread.move': 'Перемещать темы',
  'thread.archive': 'Переносить темы в архив',
  'thread.delete': 'Удалять темы',
  'solve.any': 'Отмечать любые темы решёнными',
  'report.create': 'Отправлять жалобы',
  'report.handle': 'Рассматривать жалобы',
  'pm.send': 'Отправлять личные сообщения',
  'warn.issue': 'Выдавать предупреждения',
  'user.mute': 'Выдавать мут',
  'user.ban': 'Блокировать аккаунты',
  'user.manage': 'Управлять пользователями',
  'role.assign': 'Назначать роли (ниже своей)',
  'role.manage': 'Управлять ролями, цветами и правами',
  'category.manage': 'Управлять категориями и разделами',
  'news.manage': 'Управлять новостями',
  'settings.manage': 'Менять настройки форума',
  'audit.view': 'Видеть журнал действий (базовый)',
  'audit.view_all': 'Видеть полный журнал действий',
  'admin.access': 'Доступ в панель управления',
};
const base = ['thread.create', 'post.create', 'post.edit_own', 'post.delete_own', 'report.create', 'pm.send'];
const helper = [...base, 'solve.any'];
const moderator = [...helper, 'post.edit_any', 'post.delete_any', 'thread.close', 'thread.pin', 'thread.move', 'thread.archive', 'report.handle', 'warn.issue', 'user.mute', 'admin.access', 'audit.view'];
const admin = [...moderator, 'user.ban', 'user.manage', 'role.assign', 'category.manage', 'news.manage', 'thread.delete', 'audit.view_all'];
const founder = Object.keys(PERMS);
const ROLE_PERMS = { user: base, helper, moderator, admin, founder };

function userPerms(db, uid) {
  return new Set(db.prepare('SELECT DISTINCT rp.perm FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?').all(uid).map(r => r.perm));
}
function userRoles(db, uid) {
  return db.prepare('SELECT r.* FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=? ORDER BY r.priority DESC').all(uid);
}
// Может ли actor управлять target (санкции, роли): нельзя себя и равных/старших, кроме держателей role.manage.
function canManageUser(actor, target) {
  if (!actor || !target || actor.id === target.id) return false;
  return actor.priority > target.priority || actor.perms.has('role.manage');
}
function canViewSection(me, s) { return s.view_min === 0 || (!!me && me.priority >= s.view_min); }
module.exports = { PERMS, ROLE_PERMS, userPerms, userRoles, canManageUser, canViewSection };

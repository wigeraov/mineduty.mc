const path = require('path');
const env = process.env;
const isProd = env.NODE_ENV === 'production';
if (isProd && !env.SESSION_SECRET) throw new Error('Задайте SESSION_SECRET в окружении (см. .env.example)');
module.exports = {
  isProd,
  port: +env.PORT || 3000,
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'forum.db'),
  uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
  baseUrl: env.BASE_URL || 'http://localhost:3000',
  bcryptCost: +env.BCRYPT_COST || 12,
  floodSeconds: env.FLOOD_SECONDS !== undefined ? +env.FLOOD_SECONDS : 10,
  smtp: { host: env.SMTP_HOST, port: +env.SMTP_PORT || 587, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM || 'MineDuty <noreply@localhost>' },
  perPage: { threads: 20, posts: 15, users: 30, search: 20 },
  editWindowMs: 24 * 3600 * 1000,
  // Цвета и названия ролей по умолчанию. После первого запуска они хранятся в БД
  // и меняются в админ-панели (Роли и цвета).
  roles: [
    { key: 'user',      name: 'Пользователь',  color: '#b9b9c3', icon: '👤', priority: 10, is_staff: 0 },
    { key: 'helper',    name: 'Хелпер',        color: '#4ade80', icon: '🛟', priority: 20, is_staff: 1 },
    { key: 'moderator', name: 'Модератор',     color: '#38bdf8', icon: '🛡️', priority: 30, is_staff: 1 },
    { key: 'admin',     name: 'Администратор', color: '#ef4444', icon: '⚔️', priority: 40, is_staff: 1 },
    { key: 'founder',   name: 'Основатель',    color: '#fbbf24', icon: '👑', priority: 50, is_staff: 1 },
  ],
};

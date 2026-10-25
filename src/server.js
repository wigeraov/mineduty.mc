const config = require('./config');
const { open } = require('./db');
const { createApp } = require('./app');
const db = open();
const app = createApp(db);
const founders = db.prepare("SELECT COUNT(*) c FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.key='founder'").get().c;
app.listen(config.port, () => {
  console.log(`MineDuty Forum: ${config.baseUrl.replace(/:\d+$/, '')}:${config.port} (${config.isProd ? 'production' : 'development'})`);
  if (!founders) console.log('Основатель ещё не создан. Выполните: npm run create-founder');
});

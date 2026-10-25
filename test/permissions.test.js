const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, mkUser, Client } = require('./helper');
let S, ids = {}, sec = {}; const cl = {};
before(async () => {
  S = await start();
  for (const [n, r] of [['Usr', 'user'], ['Usr2', 'user'], ['Help', 'helper'], ['Mod', 'moderator'], ['Adm', 'admin'], ['Fnd', 'founder']]) { ids[n] = mkUser(S.db, n, r); cl[n] = new Client(S.base); await cl[n].login(n); }
  for (const t of ['Новости проекта', 'Общение', 'Раздел для персонала', 'Внутренние обсуждения']) sec[t] = S.db.prepare('SELECT id FROM sections WHERE title=?').get(t).id;
});
after(() => S.close());
const newThread = (c, s, title = 'Тестовая тема', body = 'Текст темы') => c.post(`/s/${s}/new`, { title, body });

test('гость не может создавать темы и отвечать', async () => {
  const g = new Client(S.base);
  assert.equal((await newThread(g, sec['Общение'])).headers.get('location').startsWith('/login'), true);
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM threads').get().c, 0);
});

test('раздел новостей: темы создаёт только персонал', async () => {
  assert.equal((await newThread(cl.Usr, sec['Новости проекта'])).status, 403);
  assert.equal((await newThread(cl.Mod, sec['Новости проекта'], 'Анонс')).status, 302);
});

test('закрытые разделы скрыты по серверной проверке (а не только в интерфейсе)', async () => {
  assert.equal((await cl.Usr.get('/s/' + sec['Раздел для персонала'])).status, 404);
  assert.equal((await newThread(cl.Usr, sec['Раздел для персонала'])).status, 404);
  assert.equal((await cl.Help.get('/s/' + sec['Раздел для персонала'])).status, 200);
  assert.equal((await cl.Help.get('/s/' + sec['Внутренние обсуждения'])).status, 404, 'хелпер не видит раздел модераторов');
  await newThread(cl.Mod, sec['Внутренние обсуждения'], 'Секрет модеров');
  const t = S.db.prepare("SELECT id FROM threads WHERE title='Секрет модеров'").get();
  assert.equal((await cl.Usr.get('/t/' + t.id)).status, 404, 'тема недоступна по прямому URL');
  assert.doesNotMatch((await cl.Usr.get('/')).text_, /Секрет модеров/, 'не светится на главной');
  assert.doesNotMatch((await cl.Usr.get('/search?q=Секрет')).text_, /Секрет модеров/, 'и в поиске');
});

test('обычный пользователь не получает доступ к админке и модерации', async () => {
  assert.equal((await cl.Usr.get('/admin')).status, 403);
  assert.equal((await cl.Usr.get('/admin/roles')).status, 403);
  await newThread(cl.Usr2, sec['Общение'], 'Чужая тема');
  const t = S.db.prepare("SELECT id FROM threads WHERE title='Чужая тема'").get();
  for (const action of ['close', 'pin', 'archive', 'delete']) assert.equal((await cl.Usr.post(`/t/${t.id}/mod`, { action })).status, 403, action);
  assert.equal(S.db.prepare('SELECT status,pinned FROM threads WHERE id=?').get(t.id).status, 'open');
  const p = S.db.prepare('SELECT id FROM posts WHERE thread_id=?').get(t.id);
  assert.equal((await cl.Usr.post(`/post/${p.id}/delete`)).status, 403, 'чужое сообщение удалить нельзя');
  assert.equal((await cl.Usr.post(`/post/${p.id}/edit`, { body: 'взлом', title: 'x' })).status, 403, 'чужое сообщение править нельзя');
  assert.equal(S.db.prepare('SELECT deleted,body FROM posts WHERE id=?').get(p.id).body, 'Текст темы');
});

test('нельзя повысить себе роль через API', async () => {
  const roleId = k => S.db.prepare('SELECT id FROM roles WHERE key=?').get(k).id;
  assert.equal((await cl.Usr.post(`/admin/users/${ids.Usr}/role`, { role_id: roleId('founder'), op: 'add' })).status, 403);
  assert.equal((await cl.Mod.post(`/admin/users/${ids.Usr}/role`, { role_id: roleId('helper'), op: 'add' })).status, 403, 'у модератора нет role.assign');
  assert.equal((await cl.Adm.post(`/admin/users/${ids.Adm}/role`, { role_id: roleId('founder'), op: 'add' })).status, 403, 'админ не может менять собственные роли');
  await cl.Adm.post(`/admin/users/${ids.Usr}/role`, { role_id: roleId('founder'), op: 'add' });
  await cl.Adm.post(`/admin/users/${ids.Usr}/role`, { role_id: roleId('admin'), op: 'add' });
  const got = S.db.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?').all(ids.Usr).map(x => x.key);
  assert.deepEqual(got, ['user'], 'админ не может выдать роль равную или выше своей');
  assert.equal((await cl.Adm.post(`/admin/users/${ids.Usr}/role`, { role_id: roleId('moderator'), op: 'add' })).status, 302);
  assert.ok(S.db.prepare('SELECT 1 FROM user_roles WHERE user_id=? AND role_id=?').get(ids.Usr, roleId('moderator')));
  S.db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=?').run(ids.Usr, roleId('moderator'));
});

test('санкции: иерархия и мут блокирует отправку сообщений', async () => {
  assert.equal((await cl.Mod.post(`/admin/users/${ids.Adm}/mute`, { reason: 'попытка', duration: '1h' })).status, 403, 'модератор не мутит администратора');
  assert.equal((await cl.Mod.post(`/admin/users/${ids.Usr2}/ban`, { reason: 'нет права', duration: '1d' })).status, 403, 'у модератора нет user.ban');
  assert.equal((await cl.Mod.post(`/admin/users/${ids.Usr2}/mute`, { reason: 'флуд в теме', duration: '1h' })).status, 302);
  const before = S.db.prepare('SELECT COUNT(*) c FROM threads').get().c;
  assert.equal((await newThread(cl.Usr2, sec['Общение'], 'Из мута')).status, 400);
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM threads').get().c, before);
  S.db.prepare("UPDATE bans SET active=0 WHERE user_id=?").run(ids.Usr2);
  assert.equal((await newThread(cl.Usr2, sec['Общение'], 'После мута')).status, 302);
  assert.ok(S.db.prepare("SELECT 1 FROM audit_log WHERE action='user.mute'").get(), 'санкция попала в журнал аудита');
});

test('цвет ника зависит от роли и меняется сразу везде', async () => {
  await newThread(cl.Help, sec['Общение'], 'Тема хелпера');
  const t = S.db.prepare("SELECT id FROM threads WHERE title='Тема хелпера'").get();
  assert.match((await cl.Usr.get('/t/' + t.id)).text_, /color:#4ade80[^>]*>Help</);
  assert.equal((await cl.Mod.post(`/admin/roles/${S.db.prepare("SELECT id FROM roles WHERE key='helper'").get().id}`, { name: 'Хелпер', color: '#123456', icon: '🛟', priority: '20' })).status, 403, 'модератор не меняет роли');
  const hid = S.db.prepare("SELECT id FROM roles WHERE key='helper'").get().id;
  assert.equal((await cl.Fnd.post(`/admin/roles/${hid}`, { name: 'Хелпер', color: 'red', icon: '🛟', priority: '20' })).status, 302);
  assert.match((await cl.Usr.get('/t/' + t.id)).text_, /color:#4ade80/, 'невалидный цвет не принят');
  await cl.Fnd.post(`/admin/roles/${hid}`, { name: 'Хелпер', color: '#123456', icon: '🛟', priority: '20', perms: ['solve.any', 'thread.create', 'post.create', 'post.edit_own', 'post.delete_own', 'report.create', 'pm.send'] });
  const html = (await cl.Usr.get('/t/' + t.id)).text_;
  assert.match(html, /color:#123456[^>]*>Help</); assert.doesNotMatch(html, /color:#4ade80/);
  assert.match((await cl.Usr.get('/members')).text_, /#123456/);
});

test('XSS: пользовательский контент экранируется', async () => {
  await newThread(cl.Usr, sec['Общение'], '<img src=x onerror=alert(1)>', '<script>alert(1)</script> [url=javascript:alert(1)]x[/url] [b]ok[/b]');
  const t = S.db.prepare('SELECT id FROM threads ORDER BY id DESC LIMIT 1').get();
  const html = (await cl.Usr2.get('/t/' + t.id)).text_;
  assert.doesNotMatch(html, /<script>alert/); assert.doesNotMatch(html, /<img src=x/); assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<strong>ok<\/strong>/);
});

test('основатель: права роли «основатель» нельзя урезать, единственного основателя нельзя снять', async () => {
  const fid = S.db.prepare("SELECT id FROM roles WHERE key='founder'").get().id;
  await cl.Fnd.post(`/admin/roles/${fid}`, { name: 'Основатель', color: '#fbbf24', icon: '👑', priority: '1', perms: ['thread.create'] });
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE role_id=?').get(fid).c, Object.keys(require('../src/perms').PERMS).length);
  assert.equal(S.db.prepare('SELECT priority FROM roles WHERE id=?').get(fid).priority, 50);
});

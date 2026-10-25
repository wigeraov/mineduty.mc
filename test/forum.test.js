const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, mkUser, Client } = require('./helper');
let S, A, B, M, secId;
before(async () => {
  S = await start(); mkUser(S.db, 'Anna'); mkUser(S.db, 'Boris'); mkUser(S.db, 'Mody', 'moderator');
  [A, B, M] = [new Client(S.base), new Client(S.base), new Client(S.base)];
  await A.login('Anna'); await B.login('Boris'); await M.login('Mody');
  secId = S.db.prepare("SELECT id FROM sections WHERE title='Общение'").get().id;
});
after(() => S.close());
const tid = title => S.db.prepare('SELECT id FROM threads WHERE title=?').get(title).id;

test('тема → ответ с цитатой → уведомления → реакция → счётчики', async () => {
  assert.equal((await A.post(`/s/${secId}/new`, { title: 'Привет, @Boris', body: 'Первое сообщение @Boris' })).status, 302);
  const t = tid('Привет, @Boris');
  assert.ok(S.db.prepare("SELECT 1 FROM notifications WHERE user_id=(SELECT id FROM users WHERE username='Boris') AND type='mention'").get());
  await B.post(`/t/${t}/reply`, { body: '[quote=Anna]Первое[/quote] ответ' });
  const th = S.db.prepare('SELECT replies,views FROM threads WHERE id=?').get(t);
  assert.equal(th.replies, 1);
  assert.ok(S.db.prepare("SELECT 1 FROM notifications WHERE user_id=(SELECT id FROM users WHERE username='Anna') AND type='reply'").get(), 'автору тема/цитата → уведомление');
  const p = S.db.prepare('SELECT id FROM posts WHERE thread_id=? ORDER BY id LIMIT 1').get(t);
  await B.post(`/post/${p.id}/react`, { kind: 'fire' });
  await A.post(`/post/${p.id}/react`, { kind: 'fire' }); // реакция на своё сообщение не засчитывается
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM reactions').get().c, 1);
  await B.post(`/post/${p.id}/react`, { kind: 'fire' }); // повторный клик снимает
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM reactions').get().c, 0);
  assert.equal(S.db.prepare("SELECT post_count,thread_count FROM users WHERE username='Anna'").get().thread_count, 1);
  assert.match((await B.get(`/t/${t}?quote=${p.id}`)).text_, /\[quote=Anna\]/);
});

test('редактирование: автор может, посторонний нет; удаление первого сообщения запрещено автору', async () => {
  const t = tid('Привет, @Boris'), p = S.db.prepare('SELECT id FROM posts WHERE thread_id=? ORDER BY id LIMIT 1').get(t);
  assert.equal((await A.post(`/post/${p.id}/edit`, { title: 'Привет, @Boris', body: 'Обновлено' })).status, 302);
  assert.equal(S.db.prepare('SELECT body FROM posts WHERE id=?').get(p.id).body, 'Обновлено');
  assert.equal((await B.post(`/post/${p.id}/edit`, { title: 'x', body: 'чужое' })).status, 403);
  assert.equal((await A.post(`/post/${p.id}/delete`)).status, 403);
  const reply = S.db.prepare('SELECT id FROM posts WHERE thread_id=? ORDER BY id DESC LIMIT 1').get(t);
  assert.equal((await B.post(`/post/${reply.id}/delete`)).status, 302);
  assert.equal(S.db.prepare('SELECT deleted FROM posts WHERE id=?').get(reply.id).deleted, 1);
  assert.equal(S.db.prepare('SELECT replies FROM threads WHERE id=?').get(t).replies, 0);
});

test('жалоба → модератор рассматривает → автор жалобы получает уведомление', async () => {
  const t = tid('Привет, @Boris'), p = S.db.prepare('SELECT id FROM posts WHERE thread_id=? ORDER BY id LIMIT 1').get(t);
  await B.post(`/post/${p.id}/report`, { reason: 'Нарушение правил форума' });
  const rep = S.db.prepare('SELECT * FROM reports').get(); assert.equal(rep.status, 'open');
  assert.equal((await B.get('/admin/reports')).status, 403);
  assert.match((await M.get('/admin/reports')).text_, /Нарушение правил форума/);
  await M.post(`/admin/reports/${rep.id}`, { status: 'resolved', note: 'Принято' });
  assert.equal(S.db.prepare('SELECT status FROM reports WHERE id=?').get(rep.id).status, 'resolved');
  assert.ok(S.db.prepare("SELECT 1 FROM notifications WHERE type='report' AND user_id=(SELECT id FROM users WHERE username='Boris')").get());
});

test('модерация темы: закрыть → ответ запрещён, открыть → разрешён', async () => {
  const t = tid('Привет, @Boris');
  await M.post(`/t/${t}/mod`, { action: 'close' });
  await B.post(`/t/${t}/reply`, { body: 'в закрытую тему' });
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM posts WHERE thread_id=? AND deleted=0').get(t).c, 1);
  await M.post(`/t/${t}/mod`, { action: 'open' });
  await B.post(`/t/${t}/reply`, { body: 'снова можно' });
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM posts WHERE thread_id=? AND deleted=0').get(t).c, 2);
  assert.ok(S.db.prepare("SELECT 1 FROM audit_log WHERE action='thread.close'").get());
});

test('пагинация, поиск, личные сообщения, уведомления', async () => {
  for (let i = 0; i < 22; i++) await A.post(`/s/${secId}/new`, { title: `Массовая тема ${i}`, body: 'текст про алмазы' });
  const r1 = await A.get(`/s/${secId}`), r2 = await A.get(`/s/${secId}?page=2`);
  assert.match(r1.text_, /page=2/); assert.equal(r2.status, 200);
  assert.match((await A.get('/search?q=Массовая+тема+3')).text_, /Массовая тема 3/);
  assert.match((await A.get('/search?type=posts&q=алмазы')).text_, /алмазы/);
  assert.equal((await A.get('/search?q=%25_')).status, 200, 'wildcard-символы экранируются');
  await A.post('/messages/Boris', { body: 'Привет в личку' });
  assert.match((await B.get('/messages')).text_, /Привет в личку/);
  assert.match((await B.get('/messages/Anna')).text_, /Привет в личку/);
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM private_messages WHERE read=0").get().c, 0, 'диалог помечается прочитанным');
  S.db.prepare("UPDATE users SET pm_privacy='nobody' WHERE username='Boris'").run();
  await A.post('/messages/Boris', { body: 'не должно дойти' });
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM private_messages').get().c, 1, 'настройка приватности соблюдается');
  assert.equal((await new Client(S.base).get('/messages/Anna')).status, 302, 'гость не читает ЛС');
  const json = JSON.parse((await B.get('/notifications/recent.json')).text_); assert.ok(Array.isArray(json));
  await B.post('/notifications/read');
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM notifications WHERE read=0 AND user_id=(SELECT id FROM users WHERE username='Boris')").get().c, 0);
});

test('все публичные страницы и админка отдают 200', async () => {
  const F = new Client(S.base); mkUser(S.db, 'Boss', 'founder'); await F.login('Boss');
  for (const p of ['/', '/members', '/search', '/u/Anna', '/u/Anna?tab=awards', '/settings', '/notifications', '/messages', `/s/${secId}`, `/s/${secId}/new`,
    '/admin', '/admin/users', '/admin/roles', '/admin/categories', '/admin/reports', '/admin/sanctions', '/admin/content', '/admin/news', '/admin/settings', '/admin/logs'])
    assert.equal((await F.get(p)).status, 200, p);
  assert.equal((await new Client(S.base).get('/u/Anna')).status, 200, 'профиль виден гостю');
  assert.equal((await new Client(S.base).get('/nonexistent')).status, 404);
});

test('загрузка изображений: проверка сигнатуры, а не расширения', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const up = async (buf, name) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return fetch(S.base + '/upload', { method: 'POST', headers: { cookie: A.cookie, 'x-csrf-token': await A.token() }, body: fd }); };
  const ok = await up(png, 'a.png'); assert.equal(ok.status, 200); assert.match((await ok.json()).url, /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.equal((await up(Buffer.from('<?php system($_GET[0]); ?>'), 'shell.png')).status, 400);
  const noCsrf = new FormData(); noCsrf.append('file', new Blob([png]), 'a.png');
  assert.equal((await fetch(S.base + '/upload', { method: 'POST', headers: { cookie: A.cookie }, body: noCsrf })).status, 403);
});

(function () {
  var $ = function (s, c) { return (c || document).querySelector(s); }, $$ = function (s, c) { return [].slice.call((c || document).querySelectorAll(s)); };
  var csrf = (document.querySelector('meta[name=csrf]') || {}).content || '';
  // мобильное меню
  $$('[data-toggle]').forEach(function (b) { b.addEventListener('click', function () { var t = document.getElementById(b.dataset.toggle); if (t) t.classList.toggle('open'); }); });
  // выпадающие панели
  $$('.dd > [data-dd]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); var d = b.parentNode, was = d.classList.contains('open'); $$('.dd.open').forEach(function (x) { x.classList.remove('open'); }); if (!was) { d.classList.add('open'); if (b.dataset.dd === 'notif') loadNotifs(); } });
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.dd')) $$('.dd.open').forEach(function (x) { x.classList.remove('open'); }); });
  function loadNotifs() {
    var box = $('#notif-list'); if (!box) return;
    fetch('/notifications/recent.json', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (items) {
      box.textContent = '';
      if (!items.length) { box.textContent = 'Пока нет уведомлений'; return; }
      items.forEach(function (n) { var a = document.createElement('a'); a.href = n.href; a.textContent = (n.read ? '' : '● ') + n.text; var s = document.createElement('small'); s.className = 'muted'; s.textContent = ' · ' + n.when; a.appendChild(s); box.appendChild(a); });
    }).catch(function () { box.textContent = 'Не удалось загрузить'; });
  }
  // подтверждение опасных действий
  var dlg = $('#confirm-dlg'), pending = null;
  document.addEventListener('submit', function (e) {
    var f = e.target; if (f.dataset.confirm && dlg && !f.dataset.ok) { e.preventDefault(); pending = f; $('#confirm-text').textContent = f.dataset.confirm; dlg.showModal(); }
  });
  if (dlg) dlg.addEventListener('close', function () { if (dlg.returnValue === 'yes' && pending) { pending.dataset.ok = '1'; pending.submit(); } pending = null; });
  // редактор: форматирование, загрузка изображений, черновики
  var ta = $('textarea[data-editor]');
  if (ta) {
    var wrap = function (open, close) { var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value; ta.value = v.slice(0, s) + open + v.slice(s, e) + close + v.slice(e); ta.focus(); ta.selectionStart = s + open.length; ta.selectionEnd = e + open.length; ta.dispatchEvent(new Event('input')); };
    $$('.toolbar [data-bb]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.dataset.bb;
        if (t === 'url') { var u = prompt('Адрес ссылки (https://…)'); if (u) wrap('[url=' + u + ']', '[/url]'); } else wrap('[' + t + ']', '[/' + t + ']');
      });
    });
    var file = $('#img-file'), up = $('[data-bb-img]');
    if (up && file) {
      up.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        if (!file.files[0]) return; var fd = new FormData(); fd.append('file', file.files[0]);
        fetch('/upload', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': csrf }, credentials: 'same-origin' }).then(function (r) { return r.json(); })
          .then(function (j) { if (j.url) wrap('[img]' + j.url + '[/img]', ''); else alert(j.error || 'Ошибка загрузки'); }).catch(function () { alert('Ошибка загрузки'); }); file.value = '';
      });
    }
    var key = ta.dataset.draft;
    if (key) {
      try { var d = localStorage.getItem('draft:' + key); if (d && !ta.value) ta.value = d; } catch (e) {}
      ta.addEventListener('input', function () { try { localStorage.setItem('draft:' + key, ta.value); } catch (e) {} });
      if (ta.form) ta.form.addEventListener('submit', function () { try { localStorage.removeItem('draft:' + key); } catch (e) {} });
    }
  }
})();

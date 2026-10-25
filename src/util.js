const crypto = require('crypto');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// BBCode: сначала экранируем весь HTML, потом разрешаем только известные теги. Сырой HTML от пользователя невозможен.
function bbcode(src) {
  let s = esc(src);
  const codes = [];
  s = s.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (_, c) => { codes.push(c.replace(/^\n/, '')); return `\u0000${codes.length - 1}\u0000`; });
  for (const [t, h] of [['b', 'strong'], ['i', 'em'], ['u', 'u'], ['s', 's']])
    s = s.replace(new RegExp(`\\[${t}\\]([\\s\\S]*?)\\[/${t}\\]`, 'gi'), `<${h}>$1</${h}>`);
  s = s.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '<details class="spoiler"><summary>Спойлер</summary>$1</details>');
  for (let i = 0; i < 5; i++)
    s = s.replace(/\[quote(?:=([^\]\n]{1,32}))?\]((?:(?!\[quote)[\s\S])*?)\[\/quote\]/gi, (m, a, b) => `<blockquote>${a ? `<cite>${a}</cite>` : ''}${b}</blockquote>`);
  s = s.replace(/\[url=(https?:\/\/[^\]\s]{1,500})\]([\s\S]*?)\[\/url\]/gi, '<a href="$1" rel="nofollow noopener ugc" target="_blank">$2</a>');
  s = s.replace(/\[url\](https?:\/\/[^\s\[]{1,500})\[\/url\]/gi, '<a href="$1" rel="nofollow noopener ugc" target="_blank">$1</a>');
  s = s.replace(/\[img\](\/uploads\/[a-f0-9]{32}\.(?:png|jpe?g|gif|webp))\[\/img\]/gi, '<img class="post-img" src="$1" alt="" loading="lazy">');
  s = s.replace(/(^|[\s>])@([A-Za-z0-9_]{3,20})\b/g, '$1<a class="mention" href="/u/$2">@$2</a>');
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre><code>${codes[+i]}</code></pre>`);
}
const mentions = text => [...new Set([...String(text).matchAll(/(?:^|[\s>(])@([A-Za-z0-9_]{3,20})\b/g)].map(m => m[1]))].slice(0, 10);
function ago(ts) {
  if (!ts) return 'никогда';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин. назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч. назад`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} дн. назад` : fmtDate(ts);
}
const fmtDate = ts => ts ? new Date(ts).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }) : '—';
function pager(page, total, per) {
  const pages = Math.max(1, Math.ceil(total / per));
  page = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  return { page, pages, per, total, offset: (page - 1) * per };
}
const likeEsc = q => String(q).replace(/[\\%_]/g, '\\$&');
const token = () => crypto.randomBytes(32).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const HEX = /^#[0-9a-fA-F]{6}$/;
module.exports = { esc, bbcode, mentions, ago, fmtDate, pager, likeEsc, token, sha, safeEq, HEX };

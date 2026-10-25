const session = require('express-session');
class SqliteStore extends session.Store {
  constructor(db) { super(); this.db = db; this.n = 0; }
  get(sid, cb) { try { const r = this.db.prepare('SELECT data,expires FROM sessions WHERE sid=?').get(sid); cb(null, r && r.expires > Date.now() ? JSON.parse(r.data) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      this.db.prepare('INSERT OR REPLACE INTO sessions(sid,data,expires) VALUES(?,?,?)').run(sid, JSON.stringify(sess), exp);
      if (++this.n % 200 === 0) this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
}
module.exports = SqliteStore;

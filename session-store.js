'use strict';
/** Persist Express sessions in Node's built-in SQLite database. */
function createSessionStore(session, db) {
    const day = 24 * 60 * 60 * 1000;
    const fallbackLifetime = 7 * day;
    class SQLiteSessionStore extends session.Store {
        get(sid, callback) {
            try {
                const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
                if (!row)
                    return callback(null, null);
                if (row.expires_at <= Date.now()) {
                    this.destroy(sid, () => { });
                    return callback(null, null);
                }
                return callback(null, JSON.parse(row.data));
            }
            catch (error) {
                return callback(error);
            }
        }
        set(sid, sessionData, callback = () => { }) {
            try {
                const expiresAt = expirationFor(sessionData, fallbackLifetime);
                db.prepare(`
          INSERT INTO sessions (sid, data, expires_at)
          VALUES (?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET
            data = excluded.data,
            expires_at = excluded.expires_at
        `).run(sid, JSON.stringify(sessionData), expiresAt);
                callback(null);
            }
            catch (error) {
                callback(error);
            }
        }
        touch(sid, sessionData, callback = () => { }) {
            try {
                db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expirationFor(sessionData, fallbackLifetime), sid);
                callback(null);
            }
            catch (error) {
                callback(error);
            }
        }
        destroy(sid, callback = () => { }) {
            try {
                db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
                callback(null);
            }
            catch (error) {
                callback(error);
            }
        }
        clear(callback = () => { }) {
            try {
                db.exec('DELETE FROM sessions');
                callback(null);
            }
            catch (error) {
                callback(error);
            }
        }
        purgeExpired() {
            db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
        }
    }
    return new SQLiteSessionStore();
}
function expirationFor(sessionData, fallbackLifetime) {
    const provided = sessionData?.cookie?.expires;
    const timestamp = provided ? new Date(provided).getTime() : NaN;
    return Number.isFinite(timestamp) ? timestamp : Date.now() + fallbackLifetime;
}
module.exports = { createSessionStore };

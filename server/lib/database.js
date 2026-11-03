'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'app.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0,
      autoplay INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, series_id TEXT NOT NULL,
      metadata TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, series_id)
    );
    CREATE TABLE IF NOT EXISTS playback (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT NOT NULL,
      series_id TEXT NOT NULL, vid TEXT NOT NULL, episode INTEGER NOT NULL, metadata TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT -1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, series_id TEXT NOT NULL,
      vid TEXT NOT NULL, episode INTEGER NOT NULL, position REAL NOT NULL, duration REAL NOT NULL,
      completed INTEGER NOT NULL, ordinal INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,series_id,vid)
    );
    CREATE TABLE IF NOT EXISTS history (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, series_id TEXT NOT NULL,
      metadata TEXT NOT NULL, vid TEXT NOT NULL, episode INTEGER NOT NULL,
      position REAL NOT NULL, duration REAL NOT NULL, completed INTEGER NOT NULL,
      ordinal INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,series_id)
    );
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      series_id TEXT NOT NULL, metadata TEXT NOT NULL, vid TEXT NOT NULL, episode INTEGER NOT NULL,
      quality TEXT NOT NULL, state TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, UNIQUE(user_id,series_id,vid,quality)
    );
    CREATE INDEX IF NOT EXISTS downloads_state ON downloads(state,created_at);
    CREATE INDEX IF NOT EXISTS history_user ON history(user_id,updated_at);
    CREATE INDEX IF NOT EXISTS progress_user ON progress(user_id,updated_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    PRAGMA user_version=1;
  `);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function audit(actor, action, target = '') {
    db.prepare('INSERT INTO audit(actor,action,target,created_at) VALUES(?,?,?,?)').run(actor, action, target, Date.now());
    db.exec('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1000)');
  }
  return { db, transaction, audit, close: () => db.close() };
}
module.exports = { openDatabase };

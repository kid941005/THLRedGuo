'use strict';
const crypto = require('node:crypto');
const { fail } = require('./accounts');
const numericId = value => { if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) fail(400, '剧集或分集编号无效'); return value; };
function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '剧集信息无效');
  const series_id = numericId(value.series_id);
  const text = (key, max) => typeof value[key] === 'string' ? value[key].slice(0, max) : '';
  const cover = text('cover', 2048);
  return { series_id, title: text('title', 200) || '短剧 ' + series_id, cover: /^https?:\/\//i.test(cover) ? cover : '',
    abstract: text('abstract', 3000), episode_cnt: Number.isSafeInteger(value.episode_cnt) ? Math.max(0, Math.min(10000, value.episode_cnt)) : 0 };
}
function createLibrary({ db, transaction }) {
  const rows = (table, user) => db.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY updated_at DESC LIMIT 500`).all(user.id)
    .map(row => ({ ...JSON.parse(row.metadata), ...row, metadata: undefined, user_id: undefined, completed: !!row.completed }));
  function favorites(user) { return rows('favorites', user); }
  function history(user) { return rows('history', user); }
  function favorite(user, value, status) {
    const item = metadata(value);
    if (!['want', 'watching', 'completed'].includes(status)) fail(400, '追剧状态无效');
    if (!db.prepare('SELECT series_id FROM favorites WHERE user_id=? AND series_id=?').get(user.id, item.series_id) &&
      db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(user.id).count >= 500) fail(409, '追剧最多保存 500 部');
    db.prepare(`INSERT INTO favorites VALUES(?,?,?,?,?) ON CONFLICT(user_id,series_id) DO UPDATE SET metadata=excluded.metadata,status=excluded.status,updated_at=excluded.updated_at`)
      .run(user.id, item.series_id, JSON.stringify(item), status, Date.now());
  }
  function detail(user, series) {
    numericId(series);
    const favorite = db.prepare('SELECT status FROM favorites WHERE user_id=? AND series_id=?').get(user.id, series);
    const recent = db.prepare('SELECT * FROM history WHERE user_id=? AND series_id=?').get(user.id, series);
    const episodes = db.prepare('SELECT vid,episode,position,duration,completed FROM progress WHERE user_id=? AND series_id=?').all(user.id, series);
    return { favorite: favorite?.status || '', recent: recent || null, episodes };
  }
  function begin(user, body) {
    const item = metadata(body.series), vid = numericId(body.vid);
    if (!Number.isInteger(body.episode) || body.episode < 1 || body.episode > 10000) fail(400, '分集序号无效');
    const id = crypto.randomUUID();
    db.prepare('DELETE FROM playback WHERE user_id=? AND created_at<?').run(user.id, Date.now() - 86400000);
    db.prepare('DELETE FROM playback WHERE user_id=? AND ordinal NOT IN (SELECT ordinal FROM playback WHERE user_id=? ORDER BY ordinal DESC LIMIT 49)').run(user.id, user.id);
    db.prepare('INSERT INTO playback(id,user_id,session_hash,series_id,vid,episode,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, user.id, user.session_hash, item.series_id, vid, body.episode, JSON.stringify(item), Date.now());
    const saved = db.prepare('SELECT position,duration,completed FROM progress WHERE user_id=? AND series_id=? AND vid=?').get(user.id, item.series_id, vid);
    return { playbackId: id, position: saved && !saved.completed ? saved.position : 0 };
  }
  function progress(user, body) {
    if (!Number.isSafeInteger(body.sequence) || body.sequence < 0 || !Number.isFinite(body.position) || body.position < 0 || body.position > 604800 ||
        !Number.isFinite(body.duration) || body.duration <= 0 || body.duration > 604800 || body.position > body.duration + 2) fail(400, '播放进度无效');
    return transaction(() => {
      const play = db.prepare('SELECT * FROM playback WHERE id=? AND user_id=? AND session_hash=?').get(body.playbackId, user.id, user.session_hash);
      if (!play) fail(409, '播放记录已过期，请重新打开剧集');
      if (play.sequence >= body.sequence) return { ok: true, ignored: true };
      db.prepare('UPDATE playback SET sequence=? WHERE id=?').run(body.sequence, play.id);
      const now = Date.now(), completed = body.completed === true && body.position >= body.duration - Math.min(10, body.duration * 0.1) ? 1 : 0;
      const position = Math.min(body.position, body.duration);
      db.prepare(`INSERT INTO progress VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,series_id,vid) DO UPDATE SET
        episode=excluded.episode,position=excluded.position,duration=excluded.duration,completed=excluded.completed,ordinal=excluded.ordinal,updated_at=excluded.updated_at
        WHERE excluded.ordinal>=progress.ordinal`).run(user.id, play.series_id, play.vid, play.episode, position, body.duration, completed, play.ordinal, now);
      db.prepare(`INSERT INTO history VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,series_id) DO UPDATE SET
        metadata=excluded.metadata,vid=excluded.vid,episode=excluded.episode,position=excluded.position,duration=excluded.duration,
        completed=excluded.completed,ordinal=excluded.ordinal,updated_at=excluded.updated_at WHERE excluded.ordinal>=history.ordinal`)
        .run(user.id, play.series_id, play.metadata, play.vid, play.episode, position, body.duration, completed, play.ordinal, now);
      db.prepare('DELETE FROM history WHERE user_id=? AND series_id NOT IN (SELECT series_id FROM history WHERE user_id=? ORDER BY updated_at DESC LIMIT 500)').run(user.id, user.id);
      db.prepare('DELETE FROM progress WHERE user_id=? AND series_id NOT IN (SELECT series_id FROM history WHERE user_id=?)').run(user.id, user.id);
      db.prepare('DELETE FROM progress WHERE user_id=? AND rowid NOT IN (SELECT rowid FROM progress WHERE user_id=? ORDER BY updated_at DESC LIMIT 10000)').run(user.id, user.id);
      return { ok: true };
    });
  }
  function removeHistory(user, series) {
    if (series) numericId(series);
    transaction(() => {
      for (const table of ['history', 'progress', 'playback']) {
        db.prepare(`DELETE FROM ${table} WHERE user_id=?${series ? ' AND series_id=?' : ''}`).run(...(series ? [user.id, series] : [user.id]));
      }
    });
  }
  return { favorites, history, detail, begin, progress, removeHistory, favorite,
    removeFavorite: (user, series) => db.prepare('DELETE FROM favorites WHERE user_id=? AND series_id=?').run(user.id, numericId(series)) };
}
module.exports = { createLibrary, numericId, metadata };

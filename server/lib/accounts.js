'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const token = () => crypto.randomBytes(32).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function username(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_-]{3,32}$/u.test(value)) fail(400, '用户名需为 3～32 位文字、数字、下划线或短横线');
  return value;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) fail(400, '密码需为 10～128 位字符');
  return value;
}
async function encode(value) {
  password(value);
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + Buffer.from(await scrypt(value, salt, 64)).toString('hex');
}
async function verify(value, encoded) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const [salt, expected] = encoded.split(':');
  const actual = Buffer.from(await scrypt(value, salt, 64));
  const bytes = Buffer.from(expected, 'hex');
  return bytes.length === actual.length && crypto.timingSafeEqual(bytes, actual);
}
function publicUser(user) { return { id: user.id, username: user.username, role: user.role, disabled: !!user.disabled, autoplay: !!user.autoplay, created_at: user.created_at }; }

function createAccounts(store, { dataDir, secureCookies = false, setupToken = process.env.SETUP_TOKEN } = {}) {
  const { db, transaction, audit } = store;
  const attempts = new Map();
  let hashing = 0;
  const setupFile = path.join(dataDir, 'setup-token');
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    if (!setupToken) {
      try { setupToken = fs.readFileSync(setupFile, 'utf8').trim(); } catch (_) {}
      if (!setupToken) { setupToken = token(); fs.writeFileSync(setupFile, setupToken, { mode: 0o600 }); }
    }
  }
  function limit(key) {
    const now = Date.now();
    if (attempts.size > 4096) for (const [id, entry] of attempts) if (now > entry.until) attempts.delete(id);
    if (attempts.size > 8192) fail(429, '登录请求过多，请稍后再试');
    let entry = attempts.get(key);
    if (!entry || now > entry.until) { entry = { count: 0, until: now + 900000 }; attempts.set(key, entry); }
    if (++entry.count > 10) fail(429, '尝试次数过多，请十五分钟后重试');
  }
  async function expensive(fn) {
    if (hashing >= 4) fail(429, '正在处理其他登录请求，请稍后重试');
    hashing++;
    try { return await fn(); } finally { hashing--; }
  }
  function createUser(name, encoded, role = 'user') {
    const id = crypto.randomUUID();
    try { db.prepare('INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,?,?)').run(id, name, encoded, role, Date.now()); }
    catch (error) { if (error.message.includes('UNIQUE')) fail(409, '用户名已存在'); throw error; }
    return db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  function cookie(res, raw, maxAge) {
    res.setHeader('Set-Cookie', `thl_session=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`);
  }
  function session(res, user) {
    const raw = token(), csrf = token();
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    // Keep at most ten simultaneous browser sessions per account.
    db.prepare('DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 9)').run(user.id, user.id);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(raw), user.id, csrf, Date.now() + 7 * 86400000);
    cookie(res, raw, 7 * 86400);
    return { user: publicUser(user), csrf };
  }
  function authenticate(req) {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('thl_session='))?.slice(12);
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) fail(401, '请先登录');
    const row = db.prepare('SELECT u.*,s.csrf,s.hash AS session_hash,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=?').get(hash(raw));
    if (!row || row.disabled || row.expires_at <= Date.now()) fail(401, '登录已失效，请重新登录');
    return row;
  }
  function csrf(req, user) {
    if (req.headers['x-csrf-token'] !== user.csrf) fail(403, '请求验证失败，请刷新页面');
  }
  function admin(user) { if (user.role !== 'admin') fail(403, '仅管理员可执行此操作'); }
  function activeAdmin(user) {
    const current = db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND s.hash=? AND s.expires_at>?').get(user.id, user.session_hash, Date.now());
    if (!current || current.disabled || current.role !== 'admin') fail(403, '管理员权限已变更');
    return current;
  }
  function status() { return { setupRequired: !db.prepare('SELECT id FROM users LIMIT 1').get() }; }
  async function setup(req, res, body) {
    if (!status().setupRequired) fail(409, '管理员已初始化');
    limit('setup:' + req.socket.remoteAddress);
    if (typeof body.token !== 'string' || !setupToken || hash(body.token) !== hash(setupToken)) fail(403, '初始化口令不正确，请从容器数据卷读取 setup-token');
    const name = username(body.username), encoded = await expensive(() => encode(body.password));
    const user = transaction(() => {
      if (!status().setupRequired) fail(409, '管理员已初始化');
      const created = createUser(name, encoded, 'admin'); audit(created.id, 'setup', created.id); return created;
    });
    try { fs.unlinkSync(setupFile); } catch (_) {}
    setupToken = null;
    return session(res, user);
  }
  async function login(req, res, body) {
    limit('ip:' + req.socket.remoteAddress);
    if (typeof body.username !== 'string' || body.username.length > 64) fail(401, '用户名或密码不正确');
    limit('name:' + body.username.toLowerCase());
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(body.username);
    const encoded = user?.password || '00000000000000000000000000000000:' + '00'.repeat(64);
    const accepted = await expensive(() => verify(body.password, encoded));
    // Recheck the account after async password work, including concurrent reset/disable.
    const current = user && db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!accepted || !current || current.disabled || current.password !== encoded) fail(401, '用户名或密码不正确');
    attempts.delete('name:' + body.username.toLowerCase());
    return session(res, current);
  }
  async function addUser(actor, body) {
    admin(actor);
    const name = username(body.username);
    if (!['admin', 'user'].includes(body.role || 'user')) fail(400, '用户角色无效');
    const encoded = await expensive(() => encode(body.password));
    activeAdmin(actor);
    const user = createUser(name, encoded, body.role || 'user'); audit(actor.id, 'create-user', user.id);
    return publicUser(user);
  }
  async function updateUser(actor, id, body) {
    admin(actor);
    const encoded = body.password === undefined ? null : await expensive(() => encode(body.password));
    return transaction(() => {
      activeAdmin(actor);
      const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!target) fail(404, '用户不存在');
      const role = body.role ?? target.role;
      if (!['admin', 'user'].includes(role) || (body.disabled !== undefined && typeof body.disabled !== 'boolean')) fail(400, '用户设置无效');
      const disabled = body.disabled === undefined ? target.disabled : Number(body.disabled);
      if (target.role === 'admin' && !target.disabled && (disabled || role !== 'admin') &&
          db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").get().count <= 1) fail(409, '必须保留至少一位可用管理员');
      db.prepare('UPDATE users SET role=?,disabled=?,password=? WHERE id=?').run(role, disabled, encoded || target.password, id);
      if (encoded || disabled || role !== target.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      audit(actor.id, 'update-user', id);
      return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
    });
  }
  async function changePassword(req, res, user, body) {
    limit('password:' + user.id);
    const encoded = await expensive(async () => {
      if (!await verify(body.currentPassword, user.password)) fail(403, '原密码不正确');
      return encode(body.password);
    });
    authenticate(req);
    const changed = db.prepare('UPDATE users SET password=? WHERE id=? AND password=?').run(encoded, user.id, user.password);
    if (!changed.changes) fail(409, '账号已变更，请重新登录');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    audit(user.id, 'change-password', user.id); cookie(res, '', 0);
    return { ok: true };
  }
  function logout(res, user) { db.prepare('DELETE FROM sessions WHERE hash=?').run(user.session_hash); cookie(res, '', 0); }
  return { authenticate, csrf, admin, status, setup, login, addUser, updateUser, changePassword, logout, publicUser };
}
module.exports = { createAccounts, fail, publicUser };

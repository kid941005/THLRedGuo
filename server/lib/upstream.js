'use strict';
/**
 * 内置服务（vendor/hongguo-web）的生命周期与密钥托管。
 *
 * 职责：
 *  1. 拉起 / 守护子进程（崩溃后自动重启）；
 *  2. 等它就绪、取回本地 api key；
 *  3. 把设备身份文件备份到数据目录，容器重建后还原同一个 device_id。
 *
 * 不处理 HTTP 请求 —— 那是 proxy.js 的事。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
  HK_PORT,
  UPSTREAM,
  VENDOR_ENTRY,
  VENDOR_ROOT,
  VENDOR_KEY_FILE,
  DATA_DIR,
  KEY_BACKUP,
} = require('./config');

const state = { child: null, ready: false, key: '' };

/** 崩溃重启的退避参数：连续失败时拉长间隔，就绪后复位 */
const RESTART_BASE_MS = 3000;
const RESTART_MAX_MS = 60000;
let restartDelay = RESTART_BASE_MS;

// ---------------------------------------------------------------- 身份备份

/** 启动前还原设备身份：容器重建后镜像内的 apikeys.json 已丢，从卷里恢复 */
function restoreKeyBackup() {
  try {
    if (fs.existsSync(VENDOR_KEY_FILE)) return false;
    if (!fs.existsSync(KEY_BACKUP)) return false;
    fs.mkdirSync(path.dirname(VENDOR_KEY_FILE), { recursive: true });
    fs.copyFileSync(KEY_BACKUP, VENDOR_KEY_FILE);
    console.log('[gateway] 已从备份恢复设备身份:', KEY_BACKUP);
    return true;
  } catch (e) {
    console.error('[gateway] 恢复设备身份失败:', e.message);
    return false;
  }
}

/** 拿到密钥后把 apikeys.json 备份到数据目录（先写临时文件再改名，避免半截文件） */
function backupKey() {
  try {
    if (!fs.existsSync(VENDOR_KEY_FILE)) return false;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${KEY_BACKUP}.tmp`;
    fs.copyFileSync(VENDOR_KEY_FILE, tmp);
    fs.renameSync(tmp, KEY_BACKUP);
    return true;
  } catch (e) {
    console.error('[gateway] 备份设备身份失败:', e.message);
    return false;
  }
}

function devicePersisted() {
  return fs.existsSync(KEY_BACKUP);
}

// ---------------------------------------------------------------- 子进程

function start() {
  if (!fs.existsSync(VENDOR_ENTRY)) {
    console.error('[gateway] 缺少内置服务入口:', VENDOR_ENTRY);
    process.exit(1);
  }
  const child = spawn(process.execPath, [VENDOR_ENTRY], {
    // 必须以 vendor 根目录为 cwd：内置服务用相对路径 server/config/ 读写配置，
    // 在 server/src 下启动会生成嵌套的 server/src/server/config 副本。
    cwd: VENDOR_ROOT,
    env: {
      ...process.env,
      PORT: String(HK_PORT),
      BIND_HOST: '127.0.0.1',
      // 容器内不弹浏览器；转码默认关闭（取流为纯解密，不需要 ffmpeg）
      HG_OPEN_BROWSER: '0',
      HG_TRANSCODE: process.env.HG_TRANSCODE || '0',
      // 只决定视频解密缓存的落盘位置；设备身份固定在 server/config/apikeys.json
      HONGGUO_DATA_DIR: DATA_DIR,
    },
    stdio: 'inherit',
  });
  state.child = child;

  child.on('error', (e) => {
    console.error('[gateway] 内置服务启动失败:', e.message);
  });
  child.on('exit', (code) => {
    console.error('[gateway] 内置服务退出，code=', code);
    state.ready = false;
    state.key = '';
    // 连续崩溃时指数退避（3s → 6s → 12s … 上限 60s）：
    // 配置错误会让子进程立刻退出，固定 3 秒重试只会把日志刷满
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
    console.error(`[gateway] ${Math.round(delay / 1000)} 秒后重启内置服务`);
    setTimeout(() => {
      start();
      // 重启后必须重新探测就绪并取新密钥，否则健康检查会一直停在 false
      wait(60000).then((ok) => {
        if (ok) ensureKey(false);
        else console.error('[gateway] 内置服务重启后仍未就绪');
      });
    }, delay);
  });
  return child;
}

function stop() {
  if (!state.child) return;
  try {
    state.child.kill('SIGTERM');
  } catch (_) {}
}

// ---------------------------------------------------------------- 就绪与密钥

function httpJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: headers || {}, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        } catch (e) {
          resolve({ status: res.statusCode, json: null, text });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/** 轮询内置服务的 /health，直到就绪或超时 */
async function wait(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await httpJson(`${UPSTREAM}/health`);
      if (status === 200) {
        state.ready = true;
        // 起来了就复位退避，下次崩溃仍从 3 秒开始
        restartDelay = RESTART_BASE_MS;
        return true;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

/** 取本地 api key（客户端不需要知道它）；force=true 用于 401 后强制刷新 */
async function ensureKey(force) {
  if (state.key && !force) return state.key;
  try {
    const { json } = await httpJson(`${UPSTREAM}/api-key`);
    if (json && typeof json.api_key === 'string' && json.api_key) {
      state.key = json.api_key;
      // 取到密钥说明 apikeys.json 已生成，立即备份，容器重建后才能还原同一设备身份
      backupKey();
    }
  } catch (_) {}
  return state.key;
}

const getKey = () => state.key;
const isReady = () => state.ready;

module.exports = {
  start,
  stop,
  wait,
  ensureKey,
  getKey,
  isReady,
  restoreKeyBackup,
  devicePersisted,
};

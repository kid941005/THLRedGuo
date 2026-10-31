'use strict';
/**
 * 网关的路径与运行参数：集中读取环境变量，其它模块只从这里取值。
 *
 * 这样做的目的：路径拼接（尤其是 vendor 目录、密钥文件、缓存目录）
 * 只在一个文件里出现，避免「谁改了 HONGGUO_DATA_DIR 却忘了另一处」。
 */

const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HK_PORT = Number(process.env.HK_PORT || 8000);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');
const QUALITY = process.env.HK_QUALITY || 'best';

/** 内置服务地址（仅本机回环，不对外） */
const UPSTREAM = `http://127.0.0.1:${HK_PORT}`;

/** 仓库内的两份资源：下发的 spider 与第三方服务入口 */
const SPIDER_FILE = path.join(__dirname, '..', '..', 'assets', 'sources', 'hongguo_gw.js');

/** 内置网页界面（单文件，无构建步骤、无外链依赖） */
const WEB_INDEX = path.join(__dirname, '..', 'web', 'index.html');
const VENDOR_ENTRY = path.join(
  __dirname,
  '..',
  'vendor',
  'hongguo-web',
  'server',
  'src',
  'main.js'
);
const VENDOR_ROOT = path.resolve(path.dirname(VENDOR_ENTRY), '..', '..');

/**
 * 内置服务把设备身份（device_id）与 api key 写在 server/config/apikeys.json，
 * 该路径固定相对 vendor 根目录，**不受 HONGGUO_DATA_DIR 影响**。
 * 容器重建会丢掉镜像层里的这个文件 → device_id 变化 → 更容易被上游风控，
 * 所以网关把它备份到数据目录，下次启动再还原。
 */
const VENDOR_KEY_FILE = path.join(VENDOR_ROOT, 'server', 'config', 'apikeys.json');

/** 数据目录：视频解密缓存与设备身份备份的根，容器内应挂卷 */
const DATA_DIR =
  process.env.HONGGUO_DATA_DIR || path.join(__dirname, '..', 'vendor', 'hongguo-web', 'data');
const KEY_BACKUP = path.join(DATA_DIR, 'apikeys.json');

const CACHE_DIR = process.env.HONGGUO_STREAM_CACHE || path.join(DATA_DIR, 'stream-cache');
const CACHE_TTL_MIN = Number(process.env.CACHE_TTL_MIN || 180);
const CACHE_MAX_MB = Number(process.env.CACHE_MAX_MB || 2048);
const CACHE_SWEEP_SEC = Number(process.env.CACHE_SWEEP_SEC || 300);

module.exports = {
  PORT,
  HK_PORT,
  PUBLIC_BASE,
  QUALITY,
  UPSTREAM,
  SPIDER_FILE,
  WEB_INDEX,
  VENDOR_ENTRY,
  VENDOR_ROOT,
  VENDOR_KEY_FILE,
  DATA_DIR,
  KEY_BACKUP,
  CACHE_DIR,
  CACHE_TTL_MIN,
  CACHE_MAX_MB,
  CACHE_SWEEP_SEC,
};

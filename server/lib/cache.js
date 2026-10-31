'use strict';
/**
 * 解密流缓存的定期清理。
 *
 * 内置服务的 /stream 是「边解密边落盘、只写不删」，长时间运行会把磁盘吃满。
 * 这里按两条规则清理：先删超过 TTL 的，再按总容量从最旧的开始淘汰。
 * 不负责生成缓存，只负责回收。
 */

const fs = require('fs');
const path = require('path');
const { CACHE_DIR, CACHE_TTL_MIN, CACHE_MAX_MB, CACHE_SWEEP_SEC } = require('./config');

let stats = { files: 0, mb: 0 };

/** 扫描一次并清理，返回本次删除的文件数 */
async function sweep() {
  let names;
  try {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    names = await fs.promises.readdir(CACHE_DIR);
  } catch (_) {
    return 0;
  }

  const entries = [];
  let total = 0;
  for (const name of names) {
    const file = path.join(CACHE_DIR, name);
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile()) continue;
      entries.push({ file, mtime: st.mtimeMs, size: st.size });
      total += st.size;
    } catch (_) {}
  }
  entries.sort((a, b) => a.mtime - b.mtime);

  const now = Date.now();
  const ttlMs = CACHE_TTL_MIN * 60 * 1000;
  const maxBytes = CACHE_MAX_MB * 1024 * 1024;
  let removed = 0;

  let alive = entries.length;
  for (const entry of entries) {
    const expired = ttlMs > 0 && now - entry.mtime > ttlMs;
    const overCap = maxBytes > 0 && total > maxBytes;
    if (!expired && !overCap) break;
    try {
      await fs.promises.unlink(entry.file);
      total -= entry.size;
      alive--;
      removed++;
    } catch (_) {
      // 文件可能正被播放请求占用（Windows 下无法删除），保留计数，下轮再试
    }
  }

  stats = { files: alive, mb: Math.round((total / 1048576) * 10) / 10 };
  if (removed > 0) {
    console.log(
      `[gateway] 清理流缓存 ${removed} 个文件，剩余 ${stats.files} 个 / ${stats.mb}MB`
    );
  }
  return removed;
}

function summary() {
  return { dir: CACHE_DIR, ...stats, ttl_min: CACHE_TTL_MIN, max_mb: CACHE_MAX_MB };
}

/** 启动即扫一次，之后按 CACHE_SWEEP_SEC 定时扫；定时器 unref 避免阻止进程退出 */
function start() {
  sweep();
  const timer = setInterval(sweep, Math.max(30, CACHE_SWEEP_SEC) * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { sweep, summary, start };

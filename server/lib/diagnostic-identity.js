'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
async function temporaryIdentity(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redguo-identity-compare-'));
  try { return await run(directory); }
  finally {
    const target = path.resolve(directory);
    if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('redguo-identity-compare-')) throw new Error('Unexpected diagnostic temporary directory');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
function compareIdentity(script, vid) {
  return temporaryIdentity(directory => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, vid], {
      env: { ...process.env, HONGGUO_DATA_DIR: directory, HONGGUO_KEY_FILE: path.join(directory, 'apikeys.json') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', size = 0, timeout = false;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 131072) child.kill(); else output += chunk.toString('utf8'); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 65000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || timeout || size > 131072) { reject(new Error('临时身份诊断未完成')); return; }
      const marker = output.lastIndexOf(String.fromCharCode(10) + '{');
      try { const report = JSON.parse(marker >= 0 ? output.slice(marker + 1) : output); resolve(report.playback || { ok: false, code: 'DIAGNOSTIC_NO_RESULT' }); }
      catch (_) { reject(new Error('临时身份诊断结果无法解析')); }
    });
  }));
}
function comparisonSummary(existing, temporary) {
  if (existing.ok) return '已有身份取址成功；若网页仍失败，需核对运行进程、具体分集和完整错误。';
  if (temporary.ok) return '临时新身份在同一容器出口成功，已有播放身份需要进一步检查；诊断未替换原身份。';
  return '已有身份与临时新身份均失败，单独重置身份没有改善证据；继续检查容器出口、请求协议和上游响应。';
}
module.exports = { temporaryIdentity, compareIdentity, comparisonSummary };

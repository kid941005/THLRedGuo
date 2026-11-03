'use strict';

// Run the vendor's offline checks without writing identities into the source tree.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const vendor = path.resolve(__dirname, '../server/vendor/hongguo-web');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thlredguo-selftest-'));
let code = 1;
try {
  fs.mkdirSync(path.join(temp, 'server/config'), { recursive: true });
  fs.copyFileSync(path.join(vendor, 'server/config/config.json'), path.join(temp, 'server/config/config.json'));
  const result = spawnSync(process.execPath, [path.join(vendor, 'server/src/main.js'), '--selftest'], {
    cwd: temp,
    env: { ...process.env, HONGGUO_CONFIG: path.join(temp, 'server/config/config.json'), HONGGUO_DATA_DIR: temp, HONGGUO_STREAM_CACHE: path.join(temp, 'stream-cache'), HG_OPEN_BROWSER: '0', HG_TRANSCODE: '0' },
    stdio: 'inherit',
    timeout: 60000,
  });
  if (result.error) console.error(result.error.message);
  code = result.status ?? 1;
} finally {
  const target = path.resolve(temp);
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('thlredguo-selftest-')) throw new Error('Unexpected temporary directory');
  fs.rmSync(target, { recursive: true, force: true });
}
process.exitCode = code;

#!/usr/bin/env node
/**
 * 数据源冒烟测试工具（零依赖，Node 18+）
 *
 * 用途：不启动 Flutter、不打包 App，直接在命令行验证 CatPawOpen 数据源脚本
 *       的 home / category / detail / play 四条链路是否可用。
 *
 * 用法：
 *   node tools/source_smoke.cjs assets/sources/hongguo_web.js
 *   node tools/source_smoke.cjs assets/sources/hongguo_web.js --category real-drama --page 2
 *   node tools/source_smoke.cjs assets/sources/hongguo_web.js --id 7699683909419666457
 *
 * 说明：
 *   - 仅模拟宿主注入的 fetch，其余全局对象与 QuickJS 沙箱保持一致（无 require / 无 Node API）。
 *   - 脚本里若使用了 require('http') 之类 Node 能力，此工具会直接报错——那正是端侧会失败的原因。
 */

const https = require('https');
const http = require('http');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function request(url, opts = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ status: 0, body: '' });
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: opts.timeoutMs || 12000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const r = await request(String(url), opts);
  return { status: r.status, body: r.body, headers: {}, text: async () => r.body };
};

function parseArgs(argv) {
  const args = { file: '', category: 'real-drama', page: 1, id: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--category') args.category = argv[++i];
    else if (a === '--page') args.page = Number(argv[++i]) || 1;
    else if (a === '--id') args.id = argv[++i];
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error('usage: node tools/source_smoke.cjs <spider.js> [--category tid] [--page n] [--id seriesId]');
  process.exit(2);
}

const abs = path.resolve(args.file);
if (!fs.existsSync(abs)) {
  console.error('file not found:', abs);
  process.exit(2);
}

const mod = { exports: {} };
const sandbox = {
  module: mod,
  exports: mod.exports,
  console,
  fetch: globalThis.fetch,
  Buffer,
  JSON,
  Date,
  Math,
  String,
  Number,
  Boolean,
  Array,
  Object,
  RegExp,
  Promise,
  encodeURIComponent,
  decodeURIComponent,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
try {
  vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: path.basename(abs) });
} catch (e) {
  console.error('脚本加载失败（端侧同样会失败）:', e.message);
  process.exit(1);
}

const spider = sandbox.module.exports;
if (!spider || typeof spider.category !== 'function') {
  console.error('未导出 spider，或缺少 category 方法');
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const meta = spider.meta || {};
  console.log(`meta   : ${meta.id || '-'} / ${meta.name || '-'} / v${meta.version || '-'} / features=${JSON.stringify(meta.features || [])}`);

  let classIds = [];
  if (typeof spider.home === 'function') {
    const home = await spider.home(true);
    const classes = (home && home.class) || [];
    classIds = classes.map((c) => String(c.type_id));
    console.log(`home   : ${classes.map((c) => `${c.type_id}(${c.type_name})`).join(', ')}`);
  }
  if (classIds.length && !classIds.includes(String(args.category))) {
    console.log(
      `catalog: 跳过 —— 分类 "${args.category}" 不在 home 返回的 ${classIds.join(' / ')} 中`
    );
    return;
  }

  const cat = await spider.category(args.category, args.page, false, {});
  const list = cat.list || [];
  console.log(`catalog: tid=${args.category} page=${cat.page} pages=${cat.pagecount} total=${cat.total} items=${list.length}`);

  const targetId = args.id || (list[0] && list[0].vod_id);
  if (!targetId) {
    console.log('       空列表，跳过 detail/play');
    return;
  }

  const det = await spider.detail(targetId);
  const vod = (det && det.vod) || {};
  const eps = String(vod.vod_play_url || '').split('#').filter(Boolean);
  console.log(`detail : ${vod.vod_name} / eps=${eps.length} / ${vod.vod_remarks || ''}`);

  if (!eps.length) {
    console.log('       无分集，跳过 play');
    return;
  }

  const playId = eps[0].split('$')[1] || eps[0];
  const play = await spider.play(vod.vod_play_from || '', playId, []);
  if (play && play.url) {
    console.log(`play   : OK ${play.url.slice(0, 90)} (quality=${play.quality || '-'})`);
  } else {
    console.log(`play   : FAIL ${(play && play.error) || 'NO_STREAM'}`);
  }
  console.log(`elapsed: ${Date.now() - t0} ms`);
})().catch((e) => {
  console.error('冒烟失败:', e && e.message ? e.message : e);
  process.exit(1);
});

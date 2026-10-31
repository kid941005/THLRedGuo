#!/usr/bin/env node
'use strict';

/**
 * 数据源契约检查 —— 确认每个 spider 都能被宿主加载并暴露最小接口。
 *
 *   node tools/source_meta_check.cjs                  # 检查 assets/sources/*.js
 *   node tools/source_meta_check.cjs path/to/a.js ... # 检查指定文件
 *
 * 只做「加载 + 结构断言」，不发网络请求，可在 CI 里秒级跑完。
 * 校验项：module.exports 存在；meta.id / meta.name / meta.version 齐全；
 *         home / category / detail / play 四个方法都是函数。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REQUIRED_METHODS = ['home', 'category', 'detail', 'play'];

function loadSpider(file) {
  const src = fs.readFileSync(file, 'utf8');
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    Buffer,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => Promise.reject(new Error('contract check: 不发起网络请求')),
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: file });
  return mod.exports;
}

function check(file) {
  const problems = [];
  let spider;
  try {
    spider = loadSpider(file);
  } catch (e) {
    return { problems: [`加载失败：${e.message}`], meta: null };
  }
  if (!spider || typeof spider !== 'object') {
    return { problems: ['module.exports 不是对象'], meta: null };
  }
  const meta = spider.meta || {};
  for (const key of ['id', 'name', 'version']) {
    if (!meta[key] || typeof meta[key] !== 'string') problems.push(`meta.${key} 缺失或不是字符串`);
  }
  for (const name of REQUIRED_METHODS) {
    if (typeof spider[name] !== 'function') problems.push(`缺少方法 ${name}()`);
  }
  return { problems, meta };
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let files = args;
  if (files.length === 0) {
    const dir = path.join(__dirname, '..', 'assets', 'sources');
    if (!fs.existsSync(dir)) {
      console.error(`source_meta_check: 目录不存在 ${dir}`);
      return 1;
    }
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(dir, f));
  }
  if (files.length === 0) {
    console.error('source_meta_check: 没有找到数据源脚本');
    return 1;
  }

  let failed = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file) || file;
    const { problems, meta } = check(file);
    if (problems.length) {
      failed++;
      console.log(`  x ${rel}`);
      for (const p of problems) console.log(`      - ${p}`);
    } else {
      console.log(`  ok ${rel} -> ${meta.id} / ${meta.name} / v${meta.version}`);
    }
  }

  if (failed) {
    console.error(`source_meta_check: ${failed}/${files.length} 个数据源未通过契约检查`);
    return 1;
  }
  console.log(`source_meta_check: 通过（${files.length} 个数据源）`);
  return 0;
}

process.exit(main());

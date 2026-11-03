#!/usr/bin/env node
'use strict';

/**
 * 仓库静态自检 —— pre-commit 钩子与 CI 共用同一套规则。
 *
 * 用法：
 *   node tools/precommit_check.cjs              # 检查暂存区（提交前，默认）
 *   node tools/precommit_check.cjs --staged     # 同上
 *   node tools/precommit_check.cjs --all        # 检查全部跟踪文件（CI）
 *
 * 检查项：
 *   1. 冲突标记（<<<<<<< / >>>>>>> 残留）
 *   2. 不该入库的文件名（apikeys.json、.env、私钥、证书库）
 *   3. 密钥字符串（GitHub token / 私钥头 / 本地 api key / admin_token / AWS AK）
 *   4. JS 语法（node --check，含 server/vendor）
 *   5. JSON 解析
 *   6. YAML 解析（需要 python + pyyaml；缺失时跳过并提示，不静默通过）
 *   7. 超大文件（>2MB 警告，>8MB 报错）
 *
 * 零第三方依赖。暂存区模式下读的是 git index 的真实内容，
 * 因此「改了但没重新 add」的半成品不会被误判为通过。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARGS = new Set(process.argv.slice(2));
const MODE_ALL = ARGS.has('--all');

const FORBIDDEN_PATH = [
  { pattern: /(^|\/)apikeys\.json$/, why: '运行期生成的本地密钥，绝不可入库' },
  { pattern: /(^|\/)playback-device\.json(?:\.tmp)?$/, why: '播放设备身份不应入库' },
  { pattern: /(?:\.sqlite(?:-wal|-shm)?$|(?:^|\/)setup-token$)/, why: '账号数据库和初始化口令不应入库' },
  { pattern: /(^|\/)\.env(?:$|\.(?!(?:example|sample|template)$))/, why: '环境变量文件可能含密钥' },
  { pattern: /\.(pem|p12|pfx|jks|keystore)$/i, why: '证书 / 密钥库文件' },
  { pattern: /(^|\/)id_(rsa|ed25519)$/, why: 'SSH 私钥' },
  { pattern: /(^|\/)stream-cache\//, why: '解密缓存属于运行期产物' },
];

const SECRETS = [
  { pattern: /ghp_[A-Za-z0-9]{20,}/, why: 'GitHub personal access token' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/, why: 'GitHub fine-grained token' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥内容' },
  { pattern: /hg_[0-9a-f]{32,}/, why: '本地 api key' },
  { pattern: /"admin_token"\s*:\s*"[0-9a-f]{16,}"/, why: '管理口令' },
  { pattern: /AKIA[0-9A-Z]{16}/, why: 'AWS access key' },
];

const JS_EXT = new Set(['.js', '.cjs', '.mjs']);
const JSON_EXT = new Set(['.json']);
const YAML_EXT = new Set(['.yml', '.yaml']);

const errors = [];
const warnings = [];
const skipped = [];

function git(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: ROOT,
    encoding: opts.buffer ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return res;
}

const rootRes = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (rootRes.status !== 0 && !MODE_ALL) {
  console.error('precommit_check: 暂存区检查需要 Git 仓库；源码快照请使用 --all');
  process.exit(2);
}
const ROOT = rootRes.status === 0 ? rootRes.stdout.trim() : path.resolve(__dirname, '..');

function snapshotFiles(dir = ROOT) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'audit', 'coverage'].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...snapshotFiles(absolute));
    else if (entry.isFile()) files.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
  }
  return files;
}

/** 收集待检查文件（相对仓库根，POSIX 分隔符） */
function collectFiles() {
  if (MODE_ALL) {
    if (rootRes.status !== 0) return snapshotFiles();
    const res = git(['ls-files', '-z']);
    return res.stdout.split('\0').filter(Boolean);
  }
  // 只取新增/修改的暂存文件；删除与重命名的旧路径不检查
  const res = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return res.stdout.split('\0').filter(Boolean);
}

/** 读取待检查内容：暂存区模式读 index，--all 模式读工作区 */
function readFile(rel) {
  if (MODE_ALL) {
    const abs = path.join(ROOT, rel);
    try {
      return fs.readFileSync(abs);
    } catch (_) {
      return null;
    }
  }
  const res = git(['show', `:${rel}`], { buffer: true });
  if (res.status !== 0) return null;
  return res.stdout;
}

function isText(buf) {
  const slice = buf.subarray(0, 8000);
  return slice.indexOf(0) === -1;
}

function findPython() {
  for (const cmd of [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean)) {
    const res = spawnSync(cmd, ['-c', 'import yaml,sys;sys.stdout.write("ok")'], {
      encoding: 'utf8',
    });
    if (res.status === 0 && (res.stdout || '').includes('ok')) return cmd;
  }
  return null;
}

function main() {
  const files = collectFiles();
  if (files.length === 0) {
    console.log('precommit_check: 没有需要检查的文件');
    return 0;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-'));
  // 中途抛异常也要清掉临时目录
  process.on('exit', () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });
  const yamlTmp = [];
  let checkedJs = 0;
  let checkedJson = 0;
  let seq = 0;

  for (const rel of files) {
    // 1) 文件名黑名单（不需要读内容）
    for (const rule of FORBIDDEN_PATH) {
      if (rule.pattern.test(rel)) {
        errors.push(`${rel}: 禁止入库（${rule.why}）`);
      }
    }

    const buf = readFile(rel);
    if (!buf) {
      warnings.push(`${rel}: 无法读取内容，已跳过`);
      continue;
    }

    // 7) 体积
    const mb = buf.length / 1048576;
    if (mb > 8) errors.push(`${rel}: 文件 ${mb.toFixed(1)} MB，超过 8 MB 上限`);
    else if (mb > 2) warnings.push(`${rel}: 文件 ${mb.toFixed(1)} MB，确认是否应入库`);

    if (!isText(buf)) continue;
    const text = buf.toString('utf8');

    // 1) 冲突标记
    if (/^<{7} |^>{7} /m.test(text)) {
      errors.push(`${rel}: 存在未解决的合并冲突标记`);
    }

    // 3) 密钥
    for (const rule of SECRETS) {
      if (rule.pattern.test(text)) {
        errors.push(`${rel}: 疑似${rule.why}（匹配 /${rule.pattern.source.slice(0, 24)}…/）`);
      }
    }

    const ext = path.extname(rel).toLowerCase();
    const tmp = path.join(tmpDir, `f${seq++}${ext}`);
    const needsTmp = JS_EXT.has(ext) || JSON_EXT.has(ext) || YAML_EXT.has(ext);
    if (!needsTmp) continue;
    fs.writeFileSync(tmp, buf);

    // 4) JS 语法
    if (JS_EXT.has(ext)) {
      checkedJs++;
      const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      if (res.status !== 0) {
        const msg = (res.stderr || '').split('\n').find((l) => l.includes('Error')) || '语法错误';
        errors.push(`${rel}: JS 语法错误 — ${msg.trim()}`);
      }
    }

    // 5) JSON
    if (JSON_EXT.has(ext)) {
      checkedJson++;
      try {
        JSON.parse(text);
      } catch (e) {
        errors.push(`${rel}: JSON 解析失败 — ${e.message}`);
      }
    }

    // 6) YAML（延后统一交给 python 批量校验）
    if (YAML_EXT.has(ext)) yamlTmp.push({ rel, tmp });
  }

  // 6) YAML：一次性调用 python，避免逐文件起进程
  if (yamlTmp.length) {
    const py = findPython();
    if (!py) {
      skipped.push(`YAML 未校验（${yamlTmp.length} 个文件）—— 未找到带 pyyaml 的 python`);
    } else {
      const script = [
        'import sys, yaml',
        'bad = 0',
        'for i in range(1, len(sys.argv), 2):',
        '    rel, fp = sys.argv[i], sys.argv[i + 1]',
        '    try:',
        '        yaml.safe_load(open(fp, encoding="utf-8"))',
        '    except Exception as e:',
        '        print(rel + "\\t" + str(e).splitlines()[0])',
        '        bad = 1',
        'sys.exit(bad)',
      ].join('\n');
      const args = ['-c', script];
      for (const item of yamlTmp) args.push(item.rel, item.tmp);
      const res = spawnSync(py, args, { encoding: 'utf8' });
      if (res.status !== 0) {
        for (const line of (res.stdout || '').trim().split('\n').filter(Boolean)) {
          const [rel, msg] = line.split('\t');
          errors.push(`${rel}: YAML 解析失败 — ${msg || '未知错误'}`);
        }
      }
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // 输出
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const s of skipped) console.log(`  - ${s}`);
  if (errors.length) {
    console.error('');
    for (const e of errors) console.error(`  x ${e}`);
    console.error('');
    console.error(`precommit_check: ${errors.length} 个问题（检查 ${files.length} 个文件）`);
    return 1;
  }

  console.log(
    `precommit_check: 通过（${files.length} 个文件，JS ${checkedJs} / JSON ${checkedJson} / YAML ${yamlTmp.length}）`
  );
  return 0;
}

process.exit(main());

'use strict';
/**
 * 下载 + 纯离线解密流水线。
 *
 * 流程：videoTrack 取 spade_a 与直链（AppSource 取址，见 videoTrack 注释）
 *      -> 下载密文 mp4
 *      -> spade 解包 content key（纯字节变换）
 *      -> AES-128-CTR 全轨解密（视频+音频各用自身逐样本 IV）
 *      -> 纯 JS 减壳剥离 CENC 信令成普通 mp4（布局不符时回落 ffmpeg remux）
 *      -> 缓存复用
 *
 * 同步 / 异步：凡发网络或文件异步 IO 的入口（videoTrack / download /
 * offlineDecrypt / ensureDecrypted / prewarm）都是 async（返回 Promise）；
 * 路径计算、缓存清理、ffmpeg 探测等纯计算保持同步。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');

const Mp4 = require('../core/mp4');
const Spade = require('../core/spade');
const Config = require('../util/config');
const Log = require('../util/log');
const Http = require('../util/http');
const AppSource = require('../service/app-source');
const { readFullySync, escapeRe } = require('../util/common');
const Cache = require('./cache-store');

/** 默认保留的缓存文件数上限。 */
const CACHE_MAX_FILES = 30;

/** 缓存根目录：
 *  1) 环境变量 HONGGUO_STREAM_CACHE 直接指定缓存目录（自检/临时覆盖用）；
 *  2) 否则取 runtime.data_dir（视频缓存根，可为空），再拼 stream-cache；
 *  3) 都为空则退回 'server'（即 server/stream-cache）。
 *  统一转绝对路径：/download 会把落盘路径回给调用方，相对路径不便定位文件。 */
function cacheDir() {
  return Cache.cacheDir();
}

/** 同键并发去重：同一集并发请求只解密一次。键为 out 路径，值为 Promise<string>。 */
const INFLIGHT = new Map();

/** 取该集指定清晰度的轨道信息。 */
async function videoTrack(vid, quality) {
  // 播放直链统一走 App 取址：b 域名 multi_video_model/v1 + fallback_api 二次请求。
  // 上游 a 域名 preload/v1 已对部分分集（后集高发）不再返回 video_model；
  // 官网播放页曾是明文直链来源，但改版后 SSR 不再输出 main_url，
  // 仅剩 360p 预览 contentUrl（付费集下载即 404），故不再走官网。
  // 拿不到时返回 null，由 ensureDecrypted 报「无直链 / video_model」。
  return AppSource.fetch(String(vid), quality);
}

// ==================== 下载 ====================

/** 带临时文件的下载（失败自动清理），返回写入的字节数。 */
async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  try {
    const size = await Http.downloadFile({ url, timeoutMs: 120000,
      headers: { 'user-agent': 'Mozilla/5.0' } }, tmp);
    fs.renameSync(tmp, dest);
    return size;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignore) { /* 忽略 */ }
    throw e;
  }
}

// ==================== 离线解密 ====================

/** 解密结果。 */
class DecryptOut {
  constructor(path = null, key = null, tracks = 0, size = 0) {
    this.path = path;
    this.key = key;
    this.tracks = tracks;
    this.size = size;
  }
}

/**
 * 纯离线解密：spadeA(base64) + 密文 mp4 -> 明文 mp4。
 *
 * 内存策略（关键）：**全程不把整个 MP4 读进堆**。
 * 1) 16 字节盒头顺读定位 moov，仅把 moov 段（几 MB）载入内存解析索引；
 * 2) 流式 copy 密文 -> outPath（调用方已把密文落在 outPath 时跳过）；
 * 3) 用 outPath 的随机读写句柄逐样本解密。
 * 因此峰值堆内存只与「moov 段大小 + 单个样本大小」有关，
 * 与视频总时长/文件大小无关（历史实现是 50~200MB/集，32 并发时会撑爆堆）。
 *
 * @returns {Promise<DecryptOut>}
 */
async function offlineDecrypt(spadeAB64, ctPath, outPath) {
  const sp = Spade.spadeToKey(spadeAB64, 0);
  const key = sp.key;
  if (!Spade.isValidKey(key)) {
    throw new Error('spade 解包失败（可能为 ver2/AES-GCM 或格式异常）');
  }

  const outSize = fs.statSync(ctPath).size;

  // ---- 1. 定位并仅加载 moov 段 ----
  let analysis;
  const raf = fs.openSync(ctPath, 'r');
  try {
    const fileLen = fs.fstatSync(raf).size;
    const moov = Mp4.findMoov(new Mp4.FileHeadReader(raf), fileLen);
    if (moov === null) throw new Error('密文文件无moov 盒（不是有效的 MP4）');
    if (moov.size > 32 * 1048576) {
      throw new Error('moov 段异常过大，无法载入内存');
    }
    const moovBuf = Buffer.alloc(moov.size);
    readFullySync(raf, moovBuf, 0, moovBuf.length, moov.start);
    analysis = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, moov.start));
  } finally {
    fs.closeSync(raf);
  }
  const encryptedTracks = analysis.tracks.filter(t => (t.ivs && t.ivs.length) || t.kid || t.constantIv);
  if (encryptedTracks.length === 0) throw new Error('密文文件无加密轨');

  // 视频轨用于 IV 自证；随后所有加密轨（视频+音频）统一用同一 content key 解密
  let video = null;
  for (const t of encryptedTracks) {
    if (t.handler === 'vide') { video = t; break; }
  }
  if (video === null) video = encryptedTracks[0];

  // ---- 2. 复制密文到 outPath（同路径时跳过：调用方已直接落在 outPath）----
  // fs.copyFileSync 由内核完成复制，无需手写 64KB 循环。
  if (ctPath !== outPath) fs.copyFileSync(ctPath, outPath);

  // ---- 3. 逐样本原地解密 ----
  let decrypted = 0;
  let nativeFallback = false;
  // 样本缓冲取 256KB：足够覆盖绝大多数样本，又不会让并发时堆占用膨胀
  const out = fs.openSync(outPath, 'r+');
  try {
    const store = new Mp4.RafStore(out, 256 * 1024);

    // ⚠️ 必须先verify 再 decrypt：若顺序颠倒，样本 0 已是明文，
    // avccSelfOk 仍会通过，导致错误的 content key 被误判为合法。
    const cands = Mp4.trackBaseIvCandidates(video);
    const vIv = Mp4.verifyVideoIv(store, video, key, cands);
    if (vIv === null || encryptedTracks.some(t => (!t.ivs || t.ivs.length !== t.sampleCount) && !t.constantIv)) {
      // Standard CENC may carry clear/encrypted subsample ranges unsupported by this JS parser.
      // No bytes have been modified yet; let ffmpeg consume the original encryption metadata.
      nativeFallback = true;
    }

    for (const t of nativeFallback ? [] : encryptedTracks) {
      // 每条轨用各自的逐样本 IV；缺失时才回退到该轨的 base_iv
      let iv;
      if (t === video) {
        iv = vIv;
      } else {
        const tc = Mp4.trackBaseIvCandidates(t);
        iv = tc.length === 0 ? vIv : tc[0];
      }
      decrypted += Mp4.decryptTrack(store, t, key, iv).decrypted;
    }
  } finally {
    fs.closeSync(out);
  }

  // 尝试生成可播放成品：纯 JS 减壳，失败回落 ffmpeg remux；
  // 两条路都失败时明确报错，半成品不会进入缓存。
  const playable = await toPlayable(outPath, nativeFallback ? key : null);
  if (!playable) throw new Error('媒体封装失败，未发布播放缓存');

  return new DecryptOut(playable, key, decrypted, outSize);
}

/** 编码器描述。 */
class Encoder {
  constructor(name, args) {
    this.name = name;
    this.args = args;
  }
}

let cachedEncoder = null;
let encoderProbed = false;

/**
 * 探测本机可用的 H.264 编码器（结果缓存）。
 * 优先级：环境变量指定 > libx264 > libopenh264 > h264_qsv / h264_v4l2m2m。
 */
function h264Encoder() {
  if (encoderProbed) return cachedEncoder;
  encoderProbed = true;

  const preset = Log.env('HG_H264_ENCODER', '').trim();
  let list = '';
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
      encoding: 'utf8', maxBuffer: 8 << 20,
    });
    if (r.error) return null;
    list = r.stdout || '';
  } catch (e) {
    return null;
  }
  const fl = list;
  const has = (n) => new RegExp('\\s' + escapeRe(n) + '\\s').test(fl);

  const table = [];
  if (preset !== '' && has(preset)) {
    table.push(new Encoder(preset, []));
  } else {
    table.push(new Encoder('libx264', ['-preset', 'veryfast', '-crf', '23']));
    table.push(new Encoder('libopenh264', ['-b:v', '2500k']));
    table.push(new Encoder('h264_qsv', ['-preset', 'veryfast']));
    table.push(new Encoder('h264_v4l2m2m', []));
  }
  for (const e of table) {
    if (has(e.name)) {
      // pix_fmt 与 crf 只对 x264/openh264 有意义
      e.args.push('-pix_fmt', 'yuv420p');
      cachedEncoder = e;
      return cachedEncoder;
    }
  }
  return null;
}

/** 是否开启转码：仅 HG_TRANSCODE=1（默认关闭）。 */
function transcodeWanted() {
  return Log.env('HG_TRANSCODE', '') === '1';
}

/** 删除文件，失败仅忽略（调用方都已有兜底路径）。 */
function deleteQuietly(f) {
  try {
    fs.unlinkSync(f);
  } catch (ignore) {
    // 忽略
  }
}

/**
 * 生成可播放成品（同步执行）。
 *
 * 默认路径：纯 JS 减壳（见 mp4.js 的 stripEncryption）——样本数据此时
 * 已是明文，只需从 moov 删掉加密信令盒（sinf/senc/saio/saiz/pssh）并把
 * chunk 偏移平移过来，mdat 原样拷贝，不依赖 ffmpeg。
 * 减壳不适用（布局异常等）或显式开启转码时，回落 ffmpeg remux；
 * 两条路都失败返回 null，由调用方保留已解密的 raw 文件。
 *
 * HONGGUO_PURE_STRIP=0 可强制走 ffmpeg（A/B 对比或应急回退）。
 *
 * 本函数是内部实现：等 ffmpeg 时不阻塞事件循环，故为 async。
 */
async function toPlayable(rawPath, decryptionKey = null) {
  const name = path.basename(rawPath);
  const dir = path.dirname(rawPath);
  // 对齐 Node 的 path.parse().name：先剥掉最后一段扩展名，再剥 .raw 段。
  // 顺序不能反——raw 文件名是 <vid>_<q>.raw.mp4，
  // 若只去 .raw 会得到 <vid>_<q>.raw.mp4.play.mp4 这种双后缀名。
  let stem = name;
  const dot = stem.lastIndexOf('.');
  if (dot > 0) stem = stem.substring(0, dot);
  if (stem.endsWith('.raw')) stem = stem.substring(0, stem.length - 4);
  if (stem === '') stem = name;
  const out = path.join(dir, stem + '.play.mp4');

  // 转码默认关闭（HG_TRANSCODE=1 才开）
  const want = transcodeWanted();

  // ---- 默认路径：纯 JS 减壳 ----
  if (!decryptionKey && !want && Log.env('HONGGUO_PURE_STRIP', '') !== '0') {
    try {
      if (Mp4.stripEncryption(rawPath, out)) {
        deleteQuietly(rawPath);
        return out;
      }
      Log.warn('纯 JS 减壳不适用，回落 ffmpeg remux：' + path.basename(rawPath));
    } catch (e) {
      Log.warn('纯 JS 减壳异常，回落 ffmpeg remux：' + e);
    }
  }

  const enc = want ? h264Encoder() : null;
  if (want && enc === null) {
    throw new Error('已开启 H.264 转码，但没有可用编码器');
  }

  const cmd = [
    '-y', '-loglevel', 'error',
    ...(decryptionKey ? ['-decryption_key', decryptionKey] : []), '-i', rawPath,
    '-c:v', enc !== null ? enc.name : 'copy',
  ];
  if (enc !== null) cmd.push(...enc.args);
  cmd.push('-c:a', enc !== null ? 'aac' : 'copy');
  if (enc !== null) cmd.push('-b:a', '128k');
  cmd.push('-movflags', '+faststart', out);

  try {
    // stderr 已合并进 stdout：限长收集（4KB），仅失败时用于诊断——
    // 旧实现整段丢弃，remux 失败时控制台只剩「remux 失败」无线索。
    const p = spawn('ffmpeg', cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errChunks = [];
    let errLen = 0;
    const collect = (chunk) => {
      if (errLen >= 4096) return;
      const take = chunk.length > (4096 - errLen)
        ? chunk.subarray(0, 4096 - errLen) : chunk;
      errChunks.push(Buffer.from(take));
      errLen += take.length;
    };
    p.stderr.on('data', collect);
    // stdout 读掉即可，防止管道写满挂死 ffmpeg
    p.stdout.on('data', () => { /* discard */ });

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 无超时的等待会让卡死的 ffmpeg 永久挂住请求线程
        try { p.kill('SIGKILL'); } catch (ignore) { /* 忽略 */ }
        resolve({ timeout: true });
      }, 60000);
      p.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: true });
      });
      p.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code });
      });
    });

    if (outcome.timeout) {
      Log.warn('ffmpeg remux 超时（60s）已强杀：' + path.basename(rawPath));
      return null;
    }
    if (outcome.error) {
      Log.warn('ffmpeg remux 异常（' + path.basename(rawPath) + '）');
      return null;
    }

    const ok = outcome.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
    if (!ok) {
      const detail = Buffer.concat(errChunks).toString().trim();
      Log.warn('ffmpeg remux 失败（' + path.basename(rawPath) + '）'
        + (detail === '' ? '' : '：' + detail));
      return null;
    }
    if (decryptionKey && !(await verifyDecodedFrames(out))) {
      Log.warn('CENC 回退未通过视频解码校验，未发布媒体');
      deleteQuietly(out);
      return null;
    }
    deleteQuietly(rawPath);
    return out;
  } catch (e) {
    Log.warn('ffmpeg remux 异常（' + path.basename(rawPath) + '）：' + e);
    return null;
  }
}

function verifyDecodedFrames(file) {
  return new Promise(resolve => {
    const child = spawn('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-frames:v', '3', '-f', 'null', '-'], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 15000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

// ==================== 缓存 ====================

/** 缓存路径三变体（均为字符串路径）。 */
class Paths3 {
  constructor(out, play, raw) {
    this.out = out;    // 未加密直下的成品
    this.play = play;  // 加密解密 + remux 后的成品
    this.raw = raw;    // remux 前的解密产物
  }
}

/**
 * 计算某集指定清晰度的缓存路径。
 *
 * 注意 play 路径：offlineDecrypt 末尾会 remux 出「基名.play.mp4」（并删掉 raw），
 * 而基名不含.raw 段，所以加密内容最终落盘的是 <vid>_<q>.play.mp4。
 * 只命中发布后的 play/out 成品，raw 始终属于未发布工作文件。
 */
function cachePaths(vid, quality) {
  const q = (quality === null || quality === undefined) ? '' : String(quality);
  let safeQ = q.replace(/[^\w]/g, '');
  if (safeQ === '') safeQ = 'best';
  if (!/^\d{1,30}$/.test(String(vid))) throw new Error('分集编号无效');
  // v2 excludes all legacy cache files, including containers published after failed decryption.
  const base = path.join(cacheDir(), vid + '_v2_' + (transcodeWanted() ? 'h264_' : '') + safeQ);
  return new Paths3(base + '.mp4', base + '.play.mp4', base + '.raw.mp4');
}

/** 命中缓存则返回可播放文件路径，否则 null。 */
function cachedPath(vid, quality) {
  const p = cachePaths(vid, quality);
  for (const c of [p.play, p.out]) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).size > 0) {
        const now = new Date();
        fs.utimesSync(c, now, now);
        return c;
      }
    } catch (e) {
      // 忽略
    }
  }
  return null;
}

// Browser preparation is polled separately from media byte reads.
const preparations = new Map();
const waiting = [];
const operations = new Map();
let active = 0;
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.MEDIA_CONCURRENCY) || 2));
function acquireSlot(key, background) {
  return new Promise((resolve, reject) => {
    const enter = () => {
      active++;
      let released = false;
      resolve(() => { if (released) return; released = true; active--; const next = waiting.shift(); if (next) next.enter(); });
    };
    if (active < CONCURRENCY) enter();
    else if (waiting.length < 64) {
      const queued = { key, background, enter };
      if (background) waiting.push(queued);
      else { const index = waiting.findIndex(item => item.background); if (index < 0) waiting.push(queued); else waiting.splice(index, 0, queued); }
    }
    else reject(new Error('取流队列已满，请稍后重试'));
  });
}
function prepare(vid, quality, retry = false, background = false) {
  const key = cachePaths(vid, quality).out;
  const hit = cachedPath(vid, quality);
  let job = preparations.get(key);
  // Reclaim bounded preparation records before inserting either hot or cold entries.
  if (!job) {
    for (const [id, old] of preparations) {
      if (old.state !== 'preparing' && (preparations.size >= 128 || Date.now() - old.at > 600000)) { clearTimeout(old.timer); if (old.release) old.release(); preparations.delete(id); }
    }
    if (preparations.size >= 128) return { state: 'failed', error: '取流队列已满，请稍后重试' };
  }
  if (!background) {
    const index = waiting.findIndex(entry => entry.key === key && entry.background);
    if (index >= 0) { const [entry] = waiting.splice(index, 1); entry.background = false; waiting.unshift(entry); }
  }
  if (hit) {
    if (!job) { job = {}; preparations.set(key, job); }
    if (job.release) job.release();
    clearTimeout(job.timer);
    job.release = Cache.retain(hit);
    job.timer = setTimeout(() => { if (job.release) job.release(); job.release = null; }, 45000);
    job.timer.unref();
    job.state = 'ready'; job.at = Date.now();
  } else if (!job || (retry && job.state === 'failed') || job.state === 'ready') {
    for (const [id, old] of preparations) {
      if (old.state !== 'preparing' && (preparations.size >= 128 || Date.now() - old.at > 600000)) {
        clearTimeout(old.timer); if (old.release) old.release(); preparations.delete(id);
      }
    }
    if (preparations.size >= 128) return { state: 'failed', error: '取流队列已满，请稍后重试' };
    // Speculative next-episode preparation should not compete with a busy playback/download queue.
    if (background && (active >= Math.max(1, CONCURRENCY - 1) || waiting.length)) return { state: 'preparing', stage: 'queued', error: '' };
    job = { state: 'preparing', at: Date.now(), error: '' };
    preparations.set(key, job);
    ensureDecrypted(vid, quality, { background }).then(() => { job.state = 'ready'; job.at = Date.now(); })
      .catch(e => {
        job.state = 'failed'; job.error = e.message; job.at = Date.now();
        job.code = /^[A-Z0-9_]{1,80}$/.test(e.code || '') ? e.code : 'MEDIA_PREPARATION_FAILED';
        job.diagnostic = e.diagnostic || null;
        // Do not log media URLs, request query, device IDs, cookies or response bodies.
        Log.warn('[playback] ' + job.code + (job.diagnostic ? ' ' + JSON.stringify(job.diagnostic) : ''));
      });
  }
  return { state: job.state, stage: job.state === 'ready' ? 'ready' : operations.get(key)?.stage || job.state,
    error: job.state === 'failed' ? job.error : '', code: job.state === 'failed' ? job.code || 'MEDIA_PREPARATION_FAILED' : '',
    diagnostic: job.state === 'failed' ? job.diagnostic || null : null };
}
async function prewarm(vid, quality) {
  const job = prepare(vid, quality);
  return job.state === 'ready' ? 'cached' : job.state === 'failed' ? 'failed' : 'warming';
}

/** 确保某集已解密并落盘缓存，返回可播放 mp4 路径。 */
async function ensureDecrypted(vid, quality, { background = false } = {}) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const p = cachePaths(vid, quality);

  const outKey = p.out;
  const exist = INFLIGHT.get(outKey);
  if (exist !== undefined) return exist; // 同集并发只解一次
  const hit = cachedPath(vid, quality);
  if (hit !== null) return hit;

  const task = (async () => {
    const operation = { stage: 'queued' }; operations.set(outKey, operation);
    const releaseSlot = await acquireSlot(outKey, background);
    let work, releaseWork;
    try {
      work = fs.mkdtempSync(path.join(cacheDir(), '.work-'));
      releaseWork = Cache.retain(work);
      const raw = path.join(work, path.basename(p.raw));
      const plain = path.join(work, path.basename(p.out));
      const t = await videoTrack(vid, quality);
      if (t === null || t === undefined || t.url === null
          || t.url === undefined || t.url === '') {
        throw new Error('无直链 / video_model');
      }
      if (!t.encrypt) {
        operation.stage = 'downloading';
        await download(t.url, plain);
        validateMedia(plain);
        if (transcodeWanted() || !hasFastStart(plain)) {
          operation.stage = 'packaging';
          const result = await toPlayable(plain);
          if (!result) throw new Error('媒体封装失败');
          fs.renameSync(result, p.play);
          return p.play;
        }
        fs.renameSync(plain, p.out);
        return p.out;
      }
      // 密文直接落在 raw 路径：offlineDecrypt 原地解密后原地减壳，
      // 省去旧实现里 .enc -> raw 的那次整文件拷贝（13MB/集的纯浪费）。
      operation.stage = 'downloading';
      await download(t.url, raw);
      operation.stage = 'decrypting';
      const r = await decryptInWorker(t.spadeA, raw);
      validateMedia(r.path);
      fs.renameSync(r.path, p.play);
      return p.play;
    } finally {
      // work is generated directly beneath cacheDir and never contains caller-supplied paths.
      try { if (work) fs.rmSync(work, { recursive: true, force: true }); } finally {
        if (releaseWork) releaseWork();
        releaseSlot();
      }
    }
  })();
  INFLIGHT.set(outKey, task);
  try {
    return await task;
  } finally {
    INFLIGHT.delete(outKey);
    operations.delete(outKey);
  }
}

function hasFastStart(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size) {
      const read = fs.readSync(fd, header, 0, 16, offset);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') return true; if (type === 'mdat') return false;
      let length = header.readUInt32BE(0);
      if (length === 1) { if (read < 16) return false; length = Number(header.readBigUInt64BE(8)); }
      if (!Number.isSafeInteger(length) || length < 8 || offset + length > size) return false;
      offset += length;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

function validateMedia(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const moov = Mp4.findMoov(new Mp4.FileHeadReader(fd), size);
    if (!moov || moov.size > 32 * 1048576) throw new Error('媒体文件无有效 moov');
    const bytes = Buffer.alloc(moov.size);
    readFullySync(fd, bytes, 0, bytes.length, moov.start);
    const tracks = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(bytes, moov.start)).tracks;
    if (!tracks.length || tracks.some(t => (t.ivs && t.ivs.length) || t.kid || t.constantIv)) throw new Error('媒体仍含加密信令或无有效轨道');
  } finally { fs.closeSync(fd); }
}

function decryptInWorker(spade, file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'decrypt-worker.js'), { workerData: { spade, file } });
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      worker.terminate().finally(() => error ? reject(error) : resolve(value));
    };
    const timer = setTimeout(() => finish(new Error('解密处理超时')), 90000);
    worker.once('message', result => result.error ? finish(new Error(result.error)) : finish(null, result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!done) finish(new Error('解密进程退出 ' + code)); });
  });
}

// ==================== 缓存上限清理 ====================

/**
 * 清理缓存目录，只保留最新的 limit 个成品文件。
 *
 * 按**最后修改时间**倒序保留，最旧的先删。每个 `<vid>_<q>` 最多留下
 * 一个成品（play > out > raw），因此实际删除数会略多于「超出的个数」。
 *
 * 两种文件不参与清理、也不会被删：
 * - `*.part`：下载临时文件，仍在被写；
 * - `*.enc`：密文临时文件，解密中且 finally 还要用。
 *
 * 上限取自 `runtime.cache.max_files`（配置文件，默认 CACHE_MAX_FILES），
 * 可被环境变量 `HONGGUO_CACHE_MAX_FILES` 覆盖；设为 0 或负数即关闭清理。
 *
 * @returns {number} 被删除的文件数
 */
function pruneCache(limit) {
  const configured = Number(Log.env('HONGGUO_CACHE_MAX_FILES',
    Config.num('runtime.cache.max_files', CACHE_MAX_FILES)));
  const count = limit == null ? configured : Number(limit);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Cache.sweep({ maxFiles: count, maxMb: 0, ttlMin: 0, graceMs: 0, cleanup: false });
}

// ==================== 环境探测 ====================

let cachedFfmpeg = null;

/** ffmpeg 是否可用（同步检查一次并缓存）。 */
function ffmpegAvailable() {
  if (cachedFfmpeg !== null) return cachedFfmpeg;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    cachedFfmpeg = !r.error && r.status === 0;
  } catch (e) {
    cachedFfmpeg = false;
  }
  return cachedFfmpeg;
}

/** 转码是否启用（HG_TRANSCODE=1 且找到编码器）。 */
function transcodeEnabled() {
  return transcodeWanted() && h264EncoderName() !== null;
}

/** 当前实际使用的 H.264 编码器名（未启用/不可用时返回 null）。 */
function h264EncoderName() {
  if (!transcodeWanted()) return null;
  if (!ffmpegAvailable()) return null;
  const e = h264Encoder();
  return e !== null ? e.name : null;
}

module.exports = {
  videoTrack,
  download,
  offlineDecrypt,
  cachePaths,
  cachedPath,
  ensureDecrypted,
  prewarm,
  prepare,
  hasFastStart,
  pruneCache,
  ffmpegAvailable,
  transcodeEnabled,
  h264EncoderName,
  DecryptOut,
  Paths3,
  CACHE_MAX_FILES,
};

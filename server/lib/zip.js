'use strict';
const fs = require('node:fs');
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); return n >>> 0; });
function crc(bytes, value) { for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8); return value >>> 0; }
async function serveZip(req, res, entries) {
  const opened = [];
  try {
    let expected = 22;
    for (const entry of entries) {
      const handle = await fs.promises.open(entry.file, 'r');
      const size = (await handle.stat()).size;
      const name = Buffer.from(entry.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 150), 'utf8');
      opened.push({ handle, size, name }); expected += size + 30 + 46 + 16 + 2 * name.length;
    }
    if (expected > 0xffffffff) throw Object.assign(new Error('合并下载超过 4GB，请分批下载'), { status: 400 });
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="redguo-episodes.zip"', 'content-length': String(expected), 'cache-control': 'no-store' });
    async function write(buffer) {
      if (res.destroyed) throw new Error('下载已断开');
      if (!res.write(buffer)) await new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(new Error('下载已断开')); };
        const cleanup = () => { res.removeListener('drain', done); res.removeListener('close', closed); res.removeListener('error', closed); };
        res.once('drain', done); res.once('close', closed); res.once('error', closed);
      });
    }
    let offset = 0;
    const central = [];
    for (const entry of opened) {
      const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6); header.writeUInt16LE(33, 12); header.writeUInt16LE(entry.name.length, 26);
      await write(header); await write(entry.name);
      const start = offset; let checksum = 0xffffffff, written = 0;
      const stream = entry.handle.createReadStream({ autoClose: false });
      const abort = () => stream.destroy(); res.once('close', abort);
      try { for await (const chunk of stream) { written += chunk.length; checksum = crc(chunk, checksum); await write(chunk); } }
      finally { res.removeListener('close', abort); stream.destroy(); }
      if (written !== entry.size) throw new Error('文件读取不完整');
      const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE((checksum ^ 0xffffffff) >>> 0, 4); descriptor.writeUInt32LE(entry.size, 8); descriptor.writeUInt32LE(entry.size, 12);
      await write(descriptor);
      const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x808, 8);
      record.writeUInt16LE(33, 14);
      record.writeUInt32LE((checksum ^ 0xffffffff) >>> 0, 16); record.writeUInt32LE(entry.size, 20); record.writeUInt32LE(entry.size, 24); record.writeUInt16LE(entry.name.length, 28); record.writeUInt32LE(start, 42);
      central.push(record, entry.name); offset += 30 + entry.name.length + entry.size + 16;
    }
    const centralSize = central.reduce((n, part) => n + part.length, 0);
    for (const part of central) await write(part);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    await write(end); res.end();
  } finally { for (const entry of opened) await entry.handle.close().catch(() => {}); }
}
module.exports = { serveZip };

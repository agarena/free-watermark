/* ══════════════════════════════════════════════
   zip.js — 零依赖 ZIP 打包（store 模式，不压缩）
   图片数据本身已是压缩格式，store 即可，体积不涨
   ══════════════════════════════════════════════ */
WM.zip = (function () {
  'use strict';

  let CRC_TABLE = null;
  function makeCrcTable() {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  function crc32(u8) {
    if (!CRC_TABLE) makeCrcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }

  /* 重名自动加序号 */
  function uniqueName(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 2;
    while (used.has(`${base}(${i})${ext}`)) i++;
    const fin = `${base}(${i})${ext}`;
    used.add(fin);
    return fin;
  }

  function create() {
    const entries = []; // {name, data, crc, time, date}
    const used = new Set();
    const enc = new TextEncoder();

    return {
      add(name, data) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        const { time, date } = dosDateTime(new Date());
        entries.push({
          name: uniqueName(name, used),
          data: u8,
          crc: crc32(u8),
          time, date,
        });
      },

      generate() {
        const chunks = [];
        const central = [];
        let offset = 0;

        for (const e of entries) {
          const nameU8 = enc.encode(e.name);

          // ── Local File Header ──
          const lfh = new DataView(new ArrayBuffer(30));
          lfh.setUint32(0, 0x04034b50, true);
          lfh.setUint16(4, 20, true);            // 版本
          lfh.setUint16(6, 1 << 11, true);       // UTF-8 文件名标志
          lfh.setUint16(8, 0, true);             // store
          lfh.setUint16(10, e.time, true);
          lfh.setUint16(12, e.date, true);
          lfh.setUint32(14, e.crc, true);
          lfh.setUint32(18, e.data.length, true);
          lfh.setUint32(22, e.data.length, true);
          lfh.setUint16(26, nameU8.length, true);
          lfh.setUint16(28, 0, true);
          chunks.push(new Uint8Array(lfh.buffer), nameU8, e.data);

          // ── Central Directory 记录 ──
          const cd = new DataView(new ArrayBuffer(46));
          cd.setUint32(0, 0x02014b50, true);
          cd.setUint16(4, 20, true);
          cd.setUint16(6, 20, true);
          cd.setUint16(8, 1 << 11, true);
          cd.setUint16(10, 0, true);
          cd.setUint16(12, e.time, true);
          cd.setUint16(14, e.date, true);
          cd.setUint32(16, e.crc, true);
          cd.setUint32(20, e.data.length, true);
          cd.setUint32(24, e.data.length, true);
          cd.setUint16(28, nameU8.length, true);
          // 30~42: 扩展字段/注释/盘号/内部属性 全 0
          cd.setUint32(38, 0, true);             // 外部属性
          cd.setUint32(42, offset, true);        // 本地头偏移
          central.push(new Uint8Array(cd.buffer), nameU8);

          offset += 30 + nameU8.length + e.data.length;
        }

        const cdStart = offset;
        let cdSize = 0;
        for (const c of central) cdSize += c.length;

        // ── EOCD ──
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, entries.length, true);
        eocd.setUint16(10, entries.length, true);
        eocd.setUint32(12, cdSize, true);
        eocd.setUint32(16, cdStart, true);

        return new Blob([...chunks, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
      },
    };
  }

  return { create };
})();

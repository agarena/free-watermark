/* ══════════════════════════════════════════════
   exif.js — 零依赖 JPEG EXIF 解析
   用途：机型参数条自动填充 / 解码时方向转正 / 导出时保留拍摄信息
   ══════════════════════════════════════════════ */
WM.exif = (function () {
  'use strict';

  /* JPEG APP1 (Exif) 里关心的标签 */
  const TAGS_IFD0 = {
    0x010f: 'make',            // 厂商
    0x0110: 'model',           // 机型
    0x0112: 'orientation',     // 方向
    0x0132: 'datetime',        // 修改时间
  };
  const TAGS_EXIF = {
    0x829a: 'exposureTime',    // 曝光时间
    0x829d: 'fNumber',         // 光圈
    0x8827: 'iso',             // ISO
    0x9003: 'datetimeOriginal',// 拍摄时间
    0x920a: 'focalLength',     // 焦距
    0xa434: 'lensModel',       // 镜头
  };

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  /* 这三个分数型标签偶尔被写成 SHORT 数组 [分子, 分母] */
  const RATIONAL_AS_SHORT_PAIR = new Set([0x829a, 0x829d, 0x920a]);

  function parse(buffer) {
    const out = { orientation: 1, exifSegment: null };
    if (!(buffer instanceof ArrayBuffer)) return out;
    const v = new DataView(buffer);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return out; // 不是 JPEG

    // 逐段扫描，找到 Exif APP1；同时记录完整段字节（导出保留用）
    let off = 2;
    let tiff = -1, tiffLen = 0;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) break;
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && size > 8) {
        // "Exif\0\0" = 0x45 78 69 66 00 00
        if (v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0x0000) {
          tiff = off + 10;
          tiffLen = size - 8;
          out.exifSegment = new Uint8Array(buffer, off, size + 2); // 含 0xFFE1 标记与长度
          break;
        }
      }
      if (marker === 0xffda) break; // SOS，后面是图像数据
      off += 2 + size;
    }
    if (tiff < 0) return out;

    try { readTiff(v, tiff, tiffLen, out); } catch (e) { /* 容错：残缺 EXIF 忽略 */ }
    return out;
  }

  function readTiff(v, tiff, tiffLen, out) {
    const bo = v.getUint16(tiff);               // II=0x4949 小端, MM=0x4d4d 大端
    const little = bo === 0x4949;
    if (!little && bo !== 0x4d4d) return;
    const u16 = p => v.getUint16(p, little);
    const u32 = p => v.getUint32(p, little);

    const ifd0 = tiff + u32(tiff + 4);
    // 拍摄参数标准位置在 Exif 子 IFD，但个别写入器直接放主目录，两处都扫
    const exifIfd = readIfd(v, tiff, ifd0, little, { ...TAGS_IFD0, ...TAGS_EXIF }, out);
    if (exifIfd) {
      readIfd(v, tiff, tiff + exifIfd, little, TAGS_EXIF, out);
    }
  }

  function readIfd(v, tiff, ifd, little, tags, out) {
    const u16 = p => v.getUint16(p, little);
    const u32 = p => v.getUint32(p, little);
    if (ifd + 2 > v.byteLength) return null;
    const count = u16(ifd);
    let exifPointer = null;
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const num = u32(e + 4);
      const unit = TYPE_SIZE[type];
      if (!unit) continue;
      const byteLen = unit * num;
      const valOff = byteLen <= 4 ? e + 8 : tiff + u32(e + 8);

      if (tag === 0x8769) { // Exif 子 IFD 指针
        exifPointer = readNumber(v, valOff, type, little);
        continue;
      }
      const key = tags[tag];
      if (!key || out[key] !== undefined) continue; // 只取首个
      try {
        if (type === 2) out[key] = readAscii(v, valOff, num);
        else if (type === 5 || type === 10) out[key] = readRational(v, valOff, num, little, type === 10);
        else if (type === 3 && RATIONAL_AS_SHORT_PAIR.has(tag) && num >= 2) {
          // 个别写入器用 SHORT 数组 [分子, 分母] 存分数
          const hi = v.getUint16(valOff, little), lo = v.getUint16(valOff + 2, little);
          out[key] = lo === 0 ? hi : hi / lo;
        }
        else out[key] = readNumber(v, valOff, type, little);
      } catch (err) { /* 单条失败不影响其余 */ }
    }
    return exifPointer;
  }

  function readAscii(v, off, num) {
    let s = '';
    for (let i = 0; i < num; i++) {
      const c = v.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  function readRational(v, off, num, little, signed) {
    const first = signed ? v.getInt32(off, little) : v.getUint32(off, little);
    const den = signed ? v.getInt32(off + 4, little) : v.getUint32(off + 4, little);
    if (num >= 2 && den === 0) return first; // 有些机型写一堆 0 分母
    return den === 0 ? 0 : first / den;
  }

  function readNumber(v, off, type, little) {
    switch (type) {
      case 1: case 7: return v.getUint8(off);
      case 3: return v.getUint16(off, little);
      case 4: return v.getUint32(off, little);
      case 9: return v.getInt32(off, little);
      default: return 0;
    }
  }

  /* ── 格式化为参数条文案 ── */
  function formatParams(ex) {
    const parts = [];
    if (ex.focalLength) parts.push(Math.round(ex.focalLength) + 'mm');
    if (ex.fNumber) parts.push('f/' + (Math.round(ex.fNumber * 10) / 10));
    if (ex.exposureTime) {
      parts.push(ex.exposureTime >= 1
        ? ex.exposureTime + 's'
        : '1/' + Math.round(1 / ex.exposureTime) + 's');
    }
    if (ex.iso) parts.push('ISO' + ex.iso);
    return parts.join(' ');
  }

  function formatDate(ex) {
    const raw = ex.datetimeOriginal || ex.datetime;
    if (!raw) return '';
    // EXIF 形如 "2026:10:06 12:30:45" → "2026.10.06"
    const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(raw);
    return m ? `${m[1]}.${m[2]}.${m[3]}` : raw;
  }

  /* 机型名：合并 make + model（很多机型字段里已含厂商名则去重） */
  function formatModel(ex) {
    const make = (ex.make || '').trim();
    const model = (ex.model || '').trim();
    if (!make) return model;
    if (model.toLowerCase().startsWith(make.toLowerCase())) return model;
    return make + ' ' + model;
  }

  /* ── 导出保留用：把原 EXIF 段插入输出 JPEG 的 SOI 之后；去掉 Orientation ── */
  function buildKeepExifSegment(origSegment) {
    if (!origSegment) return null;
    // 简化策略：整段原样保留时方向标签可能与已转正的像素不符，
    // 因此复制段并把 Orientation 值改写为 1。
    try {
      const seg = new Uint8Array(origSegment); // 复制（原 buffer 会被释放）
      if (seg.getUint16) { /* noop */ }
      const v = new DataView(seg.buffer);
      // seg 含 marker(2) + size(2) + "Exif\0\0"(6)，TIFF 从 10 开始
      const tiff = 10;
      if (seg.length < 20) return seg;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd0 = tiff + v.getUint32(tiff + 4, little);
      const count = v.getUint16(ifd0, little);
      for (let i = 0; i < count; i++) {
        const e = ifd0 + 2 + i * 12;
        if (e + 12 > seg.length) break;
        if (v.getUint16(e, little) === 0x0112) { // Orientation
          const type = v.getUint16(e + 2, little);
          if (type === 3) { // SHORT，值内联在 e+8
            v.setUint16(e + 8, 1, little);
          }
          break;
        }
      }
      return seg;
    } catch (e) { return null; }
  }

  /* 把段字节插入 JPEG blob 的 SOI(FFD8) 之后 */
  async function insertExifIntoJpeg(blob, segment) {
    if (!segment) return blob;
    try {
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      if (head[0] !== 0xff || head[1] !== 0xd8) return blob;
      const rest = new Uint8Array(await blob.slice(2).arrayBuffer());
      const out = new Uint8Array(2 + segment.length + rest.length);
      out.set(head, 0);
      out.set(segment, 2);
      out.set(rest, 2 + segment.length);
      return new Blob([out], { type: blob.type });
    } catch (e) { return blob; }
  }

  return { parse, formatParams, formatDate, formatModel, buildKeepExifSegment, insertExifIntoJpeg };
})();

/* ══════════════════════════════════════════════
   utils.js — 通用工具（全局命名空间 WM）
   ══════════════════════════════════════════════ */
window.WM = window.WM || {};
WM.utils = (function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function debounce(fn, wait) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    if (!m) return `rgba(0,0,0,${alpha})`;
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  /* 可复现的伪随机（随机散布用，保证同图同配置预览/导出一致） */
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 将文件解码为已按 EXIF 方向转正的 canvas（GIF 取首帧） */
  async function decodeImageFile(file, exifData) {
    // 优先 createImageBitmap 自动应用 EXIF 方向
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close && bmp.close();
        return c;
      } catch (e) { /* 落到 Image 元素方案 */ }
    }
    // 兜底：Image 元素 + 手动按 orientation 旋转
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('图片解码失败：' + file.name));
        im.src = url;
      });
      const orient = (exifData && exifData.orientation) || 1;
      const swap = orient >= 5 && orient <= 8; // 需要横竖互换的方向
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = swap ? h : w;
      c.height = swap ? w : h;
      const ctx = c.getContext('2d');
      const t = {
        1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
        5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
      }[orient] || [1, 0, 0, 1, 0, 0];
      ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      ctx.drawImage(img, 0, 0);
      return c;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* 采样平均亮度 0~255（决定水印自动配色的深浅） */
  function averageBrightness(source, region) {
    const N = 26;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      if (region) {
        ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, N, N);
      } else {
        ctx.drawImage(source, 0, 0, N, N);
      }
      const d = ctx.getImageData(0, 0, N, N).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        // 跳过完全透明的采样点
        if (d[i + 3] < 16) continue;
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        n++;
      }
      return n ? sum / n : 128;
    } catch (e) { return 128; }
  }

  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function toast(msg, isErr, host) {
    const el = host || document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, isErr ? 4200 : 2400);
  }

  return {
    $, $$, debounce, clamp,
    hexToRgba, hexToRgb, hashString, mulberry32,
    decodeImageFile, averageBrightness,
    formatBytes, downloadBlob, escapeHtml, toast,
  };
})();

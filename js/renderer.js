/* ══════════════════════════════════════════════
   renderer.js — 水印渲染引擎
   流水线：底图 → 构建水印单元（离屏 canvas）→ 按布局绘制
   布局四种：single 单个 / tile 平铺 / random 随机散布 / bar 底部参数条
   ══════════════════════════════════════════════ */
WM.renderer = (function () {
  'use strict';
  const U = WM.utils;

  const TEXT_LINE_HEIGHT = 1.28;

  /* 水印基准长度：横竖图混排时观感一致，用几何平均值 */
  function baseSize(w, h) { return Math.sqrt(w * h); }

  /* ── 亮度缓存（自动配色用） ── */
  const brightnessCache = new Map();
  function getBrightness(image) {
    if (!brightnessCache.has(image.id)) {
      brightnessCache.set(image.id, U.averageBrightness(image.canvas));
      if (brightnessCache.size > 200) brightnessCache.delete(brightnessCache.keys().next().value);
    }
    return brightnessCache.get(image.id);
  }

  function autoPalette(b) {
    if (b > 168) return { color: '#17181d', stroke: 'rgba(255,255,255,.4)' };
    if (b > 132) return { color: '#ffffff', stroke: 'rgba(0,0,0,.5)' };
    return { color: '#ffffff', stroke: 'rgba(0,0,0,.55)' };
  }

  /* ══════════ 水印单元构建 ══════════ */

  /* 文字块 → 离屏 canvas */
  function buildTextCell(base, text) {
    const fontPx = Math.max(9, text.sizePct / 100 * base);
    const lines = String(text.content).split('\n').filter((s, i, a) => s.length || a.length === 1);
    if (!lines.length || !String(text.content).trim()) return null;

    const t = document.createElement('canvas').getContext('2d');
    t.font = `${text.italic ? 'italic ' : ''}${text.weight} ${fontPx}px ${text.fontStack}`;
    t.textAlign = 'center';
    t.textBaseline = 'middle';
    const widths = lines.map(s => t.measureText(s).width);
    const textW = Math.max(...widths, 1);
    const lineH = fontPx * TEXT_LINE_HEIGHT;
    const textH = lineH * lines.length;

    // 内边距（底色/描边余量）
    const padX = fontPx * 0.28, padY = fontPx * 0.12;
    const bg = text.bg || {};
    const hasBg = bg.enabled;
    const outPadX = hasBg ? fontPx * 0.42 : padX;
    const outPadY = hasBg ? fontPx * 0.2 : padY;

    const c = document.createElement('canvas');
    c.width = Math.ceil(textW + outPadX * 2);
    c.height = Math.ceil(textH + outPadY * 2);
    const ctx = c.getContext('2d');

    if (hasBg) {
      const r = Math.min(c.height / 2, fontPx * 0.26);
      ctx.fillStyle = U.hexToRgba(bg.color, (bg.opacity ?? 40) / 100);
      roundRect(ctx, 0, 0, c.width, c.height, r);
      ctx.fill();
    }

    ctx.font = t.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const shadow = text.shadow || {};
    if (shadow.enabled) {
      ctx.shadowColor = shadow.color;
      ctx.shadowBlur = shadow.blur * fontPx / 64;
      ctx.shadowOffsetX = fontPx * 0.045;
      ctx.shadowOffsetY = fontPx * 0.045;
    }
    const stroke = text.stroke || {};
    const k = fontPx / 64;
    lines.forEach((line, i) => {
      const x = c.width / 2;
      const y = outPadY + (i + 0.5) * lineH;
      if (stroke.enabled && stroke.width > 0) {
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width * k;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = text.color;
      ctx.fillText(line, x, y);
    });
    return c;
  }

  /* 图片块 → 离屏 canvas（shape: none 原始 / rounded 圆角 / circle 圆形头像） */
  function buildImageCell(base, image) {
    const src = image.bitmap;
    if (!src) return null;
    const long = image.scalePct / 100 * base;
    const iw = src.width, ih = src.height;

    let c = document.createElement('canvas');
    let ctx = c.getContext('2d');

    if (image.shape === 'circle') {
      const s = Math.min(iw, ih); // 中心正方形裁圆
      c.width = c.height = Math.max(4, Math.round(long));
      const cx = c.width / 2, r = c.width / 2;
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(src, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, c.width, c.height);
    } else if (image.shape === 'rounded') {
      const ratio = iw / ih;
      const w = ratio >= 1 ? long : long * ratio;
      const h = ratio >= 1 ? long / ratio : long;
      c.width = Math.max(4, Math.round(w));
      c.height = Math.max(4, Math.round(h));
      const r = Math.min(c.width, c.height) * 0.2;
      roundRect(ctx, 0, 0, c.width, c.height, r);
      ctx.clip();
      ctx.drawImage(src, 0, 0, c.width, c.height);
    } else {
      const ratio = iw / ih;
      const w = ratio >= 1 ? long : long * ratio;
      const h = ratio >= 1 ? long / ratio : long;
      c.width = Math.max(4, Math.round(w));
      c.height = Math.max(4, Math.round(h));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, c.width, c.height);
    }
    return c;
  }

  /* 组合：图片 + 文字（图片在左，垂直居中） */
  function buildCell(image, config) {
    const base = baseSize(image.width, image.height);
    const textC = config.text.enabled ? buildTextCell(base, config.text) : null;
    const imgC = config.image.enabled ? buildImageCell(base, config.image) : null;
    if (!textC && !imgC) return null;

    if (textC && imgC) {
      const gap = Math.max(4, config.image.margin / 100 * base * 0.6);
      const c = document.createElement('canvas');
      c.width = imgC.width + gap + textC.width;
      c.height = Math.max(imgC.height, textC.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(imgC, 0, (c.height - imgC.height) / 2);
      ctx.drawImage(textC, imgC.width + gap, (c.height - textC.height) / 2);
      return c;
    }
    return textC || imgC;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ══════════ 布局 ══════════ */

  /* 单个：九宫格锚点 + 偏移 + 旋转 */
  function anchorPoint(W, H, cellW, cellH, L) {
    const m = L.marginPct / 100 * Math.min(W, H);
    const col = L.anchor % 3, row = Math.floor(L.anchor / 3);
    const x = col === 0 ? m + cellW / 2 : col === 1 ? W / 2 : W - m - cellW / 2;
    const y = row === 0 ? m + cellH / 2 : row === 1 ? H / 2 : H - m - cellH / 2;
    return { x, y };
  }

  function drawSingle(ctx, W, H, cell, L) {
    const { x, y } = anchorPoint(W, H, cell.width, cell.height, L);
    const cx = U.clamp(x + L.offX / 100 * W, -cell.width, W + cell.width);
    const cy = U.clamp(y + L.offY / 100 * H, -cell.height, H + cell.height);
    ctx.save();
    ctx.globalAlpha = L.opacity / 100;
    ctx.translate(cx, cy);
    if (L.rotate) ctx.rotate(L.rotate * Math.PI / 180);
    ctx.drawImage(cell, -cell.width / 2, -cell.height / 2);
    ctx.restore();
    return { cx, cy };
  }

  /* 平铺：旋转画布后铺满对角线区域，行列间距为水印尺寸的倍数 */
  function drawTiled(ctx, W, H, cell, L) {
    const diag = Math.hypot(W, H);
    const stepX = cell.width * (1 + L.gapX);
    const stepY = cell.height * (1 + L.gapY);
    const cols = Math.ceil(diag / stepX) + 2;
    const rows = Math.ceil(diag / stepY) + 2;
    const x0 = -cols * stepX / 2;
    const y0 = -rows * stepY / 2;

    ctx.save();
    ctx.globalAlpha = L.opacity / 100;
    ctx.translate(W / 2, H / 2);
    ctx.rotate(L.tileAngle * Math.PI / 180);
    for (let r = 0; r < rows; r++) {
      const shift = L.stagger && (r & 1) ? stepX / 2 : 0;
      const y = y0 + (r + 0.5) * stepY;
      for (let c = 0; c < cols; c++) {
        const x = x0 + (c + 0.5) * stepX + shift;
        ctx.drawImage(cell, x - cell.width / 2, y - cell.height / 2);
      }
    }
    ctx.restore();
  }

  /* 随机散布：可复现伪随机，位置/角度/缩放/透明度四因子扰动 */
  function drawRandom(ctx, W, H, cell, L, seed) {
    const rng = U.mulberry32(seed);
    const j = L.randJitter / 100; // 0~1 扰动强度
    ctx.save();
    for (let i = 0; i < L.randCount; i++) {
      let x, y, tries = 0;
      do {
        x = rng() * W; y = rng() * H; tries++;
      } while (L.avoidCenter && tries < 12 &&
        x > W * 0.3 && x < W * 0.7 && y > H * 0.28 && y < H * 0.72);

      const rot = L.rotate + (rng() * 2 - 1) * j * 55;
      const scale = 1 + (rng() * 2 - 1) * j * 0.4;
      const alpha = U.clamp(L.opacity / 100 * (1 - rng() * j * 0.55), 0.03, 1);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y);
      ctx.rotate(rot * Math.PI / 180);
      const w = cell.width * scale, h = cell.height * scale;
      ctx.drawImage(cell, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
    ctx.restore();
  }

  /* 底部参数条：渐变底 + Logo + 机型 + 参数 + 日期 */
  function drawBar(ctx, W, H, image, config) {
    const B = config.bar;
    const brandModel = [B.brand, B.model].filter(Boolean).join(' ').trim();
    if (!brandModel && !B.params && !B.date) return;

    const barH = H * B.heightPct / 100;
    const grad = ctx.createLinearGradient(0, H - barH * 1.9, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.55, `rgba(0,0,0,${B.opacity / 100 * 0.85})`);
    grad.addColorStop(1, `rgba(0,0,0,${B.opacity / 100})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, H - barH * 1.9, W, barH * 1.9);

    const cy = H - barH * 0.62;
    const padX = W * 0.03;
    let x = padX;

    // Logo（复用图片水印上传的图）
    const logo = B.useLogo ? config.image.bitmap : null;
    if (logo) {
      const lh = barH * 0.55;
      const lw = logo.width / logo.height * lh;
      ctx.drawImage(logo, x, cy - lh / 2, lw, lh);
      x += lw + barH * 0.32;
    }

    ctx.textBaseline = 'middle';
    const white = a => `rgba(255,255,255,${a})`;

    // 机型（粗）
    if (brandModel) {
      const fs1 = barH * 0.30;
      ctx.font = `700 ${fs1}px -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif`;
      ctx.fillStyle = white(0.98);
      ctx.textAlign = 'left';
      ctx.fillText(brandModel, x, cy);
      x += ctx.measureText(brandModel).width + barH * 0.3;

      // 分隔细线
      if (B.params) {
        ctx.fillStyle = white(0.35);
        ctx.fillRect(x, cy - fs1 * 0.38, Math.max(1, barH * 0.014), fs1 * 0.76);
        x += barH * 0.3;
      }
    }

    // 参数
    if (B.params) {
      const fs2 = barH * 0.255;
      ctx.font = `400 ${fs2}px -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif`;
      ctx.fillStyle = white(0.88);
      ctx.textAlign = 'left';
      ctx.fillText(B.params, x, cy);
    }

    // 日期（右侧）
    if (B.date) {
      const fs3 = barH * 0.24;
      ctx.font = `400 ${fs3}px -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif`;
      ctx.fillStyle = white(0.8);
      ctx.textAlign = 'right';
      ctx.fillText(B.date, W - padX, cy);
    }
  }

  /* ══════════ 主入口 ══════════ */

  /**
   * 渲染整张图
   * @param image {id, canvas, width, height, exif, name}
   * @param config 完整水印配置
   * @param opts {withWatermark:boolean}
   */
  function render(image, config, opts) {
    opts = opts || {};
    const W = image.width, H = image.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.canvas, 0, 0);
    if (opts.withWatermark === false) return out;

    const L = config.layout;

    // 自动配色：覆盖文字颜色与描边（深浅自适应）
    let effConfig = config;
    if (config.text.enabled && config.text.autoColor) {
      const pal = autoPalette(getBrightness(image));
      effConfig = {
        ...config,
        text: {
          ...config.text,
          color: pal.color,
          stroke: { ...(config.text.stroke || {}), enabled: true, color: pal.stroke },
        },
      };
    }

    if (L.mode === 'bar') {
      drawBar(ctx, W, H, image, effConfig);
      return out;
    }

    const cell = buildCell(image, effConfig);
    if (!cell) return out;

    if (L.mode === 'single') {
      drawSingle(ctx, W, H, cell, L);
    } else if (L.mode === 'tile') {
      drawTiled(ctx, W, H, cell, L);
    } else if (L.mode === 'random') {
      drawRandom(ctx, W, H, cell, L, U.hashString(image.id + '|' + (image.name || '')));
    }
    return out;
  }

  /* 供拖拽命中测试：单个模式下水印的中心位置与尺寸 */
  function singleHitRect(image, config) {
    const L = config.layout;
    if (L.mode !== 'single') return null;
    const cell = buildCell(image, config);
    if (!cell) return null;
    const { x, y } = anchorPoint(image.width, image.height, cell.width, cell.height, L);
    return {
      cx: x + L.offX / 100 * image.width,
      cy: y + L.offY / 100 * image.height,
      w: cell.width, h: cell.height,
      rotate: L.rotate || 0,
    };
  }

  return { render, singleHitRect, getBrightness, buildCell, anchorPoint };
})();

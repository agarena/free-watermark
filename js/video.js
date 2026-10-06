/* ══════════════════════════════════════════════
   video.js — 视频水印（预览叠加 + 实时录制导出）
   三种运动：fixed 固定 / float 漂浮（无重复曲线）/ hop 跳位（不定时随机换位）
   导出：canvas.captureStream + MediaRecorder 逐帧合成，
        音轨经 WebAudio 混入，全部本地处理
   ══════════════════════════════════════════════ */
WM.video = (function () {
  'use strict';
  const U = WM.utils;
  const R = WM.renderer;

  /* 预览挂载状态 */
  const pv = {
    mountedId: null, item: null, wrap: null, videoEl: null,
    overlay: null, stage: null, raf: 0, vw: 0, vh: 0,
  };
  let getConfig = () => null;
  let getRev = () => 0;
  const cellCache = { key: '', canvas: null };   // 水印单元缓存（配置版本号失效）
  const hopCache = new Map();                    // 跳位时刻表缓存
  let sharedActx = null;                         // 复用的 AudioContext（点击手势内预热）

  function isVideoFile(f) { return (f.type || '').startsWith('video/'); }

  /* ══════════ 元数据探测 + 首帧缩略图 ══════════ */
  function probe(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.src = url;
      v.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('视频无法解码：' + file.name));
      };
      v.onloadedmetadata = () => {
        const W = v.videoWidth, H = v.videoHeight;
        if (!W || !H) {
          URL.revokeObjectURL(url);
          reject(new Error('视频无法解码：' + file.name));
          return;
        }
        const dur = isFinite(v.duration) ? v.duration : 0;
        let done = false;
        const grab = withFrame => {
          if (done) return;
          done = true;
          let thumb = null;
          if (withFrame) {
            try {
              const c = document.createElement('canvas');
              const s = 88 / Math.max(W, H);
              c.width = Math.max(1, Math.round(W * s));
              c.height = Math.max(1, Math.round(H * s));
              c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
              thumb = c.toDataURL('image/jpeg', 0.7);
            } catch (e) { /* 部分编码取帧失败，无缩略图也可 */ }
          }
          resolve({ url, width: W, height: H, duration: dur, thumbURL: thumb });
        };
        v.addEventListener('seeked', () => grab(true));
        try { v.currentTime = Math.min(0.3, dur / 3 || 0.1); } catch (e) { /* 兜底定时器接管 */ }
        setTimeout(() => grab(v.readyState >= 2), 1500);
      };
    });
  }

  /* ══════════ 运动位置计算 ══════════ */
  function positionFor(cfg, item, t, cell, W, H) {
    const L = cfg.layout, V = cfg.video;
    if (V.mode === 'float') {
      // 两组无理数频率正弦叠加 → 路径永不精确重复，且带缓慢自转
      const ax = (W - cell.width) / 2 * V.amp / 100;
      const ay = (H - cell.height) / 2 * V.amp / 100;
      const s = V.speed;
      return {
        x: W / 2 + ax * Math.sin(t * 0.618 * s + 1.3) + ax * 0.25 * Math.sin(t * 1.732 * s + 2.6),
        y: H / 2 + ay * Math.sin(t * 1.0 * s + 4.2) + ay * 0.25 * Math.sin(t * 1.414 * s + 0.7),
        rot: 6 * Math.sin(t * 0.5 * s + 1.1),
      };
    }
    if (V.mode === 'hop') {
      const sched = hopSchedule(item, cfg, cell, W, H);
      let k = 0;
      while (k + 1 < sched.length && sched[k + 1].t <= t) k++;
      const seg = sched[k];
      let x = seg.x, y = seg.y, rot = seg.rot;
      if (V.hopSmooth && k > 0 && t - seg.t < 0.8) {
        const u = (t - seg.t) / 0.8;
        const e = u * u * (3 - 2 * u); // smoothstep
        const p = sched[k - 1];
        x = p.x + (x - p.x) * e;
        y = p.y + (y - p.y) * e;
        rot = p.rot + (rot - p.rot) * e;
      }
      return { x, y, rot };
    }
    // fixed：与图片「单个」模式共用九宫格锚点与拖拽偏移
    const p = R.anchorPoint(W, H, cell.width, cell.height, L);
    return { x: p.x + L.offX / 100 * W, y: p.y + L.offY / 100 * H, rot: L.rotate || 0 };
  }

  /* 跳位时刻表：间隔与落点都随机（可复现），首段沿用九宫格锚点 */
  function hopSchedule(item, cfg, cell, W, H) {
    const V = cfg.video;
    const key = `${item.id}|${V.hopInterval}|${W}x${H}|${cell.width | 0}x${cell.height | 0}`;
    const hit = hopCache.get(key);
    if (hit) return hit;
    const rng = U.mulberry32(U.hashString(key));
    const first = R.anchorPoint(W, H, cell.width, cell.height, cfg.layout);
    const list = [{ t: 0, x: first.x, y: first.y, rot: 0 }];
    const mX = cell.width / 2 + W * 0.02;
    const mY = cell.height / 2 + H * 0.02;
    const horizon = (item.duration || 60) + 60;
    let t = 0, guard = 0;
    while (t < horizon && guard++ < 500) {
      t += Math.max(0.8, V.hopInterval * (0.55 + rng() * 0.9));
      list.push({
        t,
        x: mX + rng() * Math.max(1, W - mX * 2),
        y: mY + rng() * Math.max(1, H - mY * 2),
        rot: (rng() * 2 - 1) * 14,
      });
    }
    if (hopCache.size > 40) hopCache.clear();
    hopCache.set(key, list);
    return list;
  }

  /* ══════════ 水印单元（与图片共用渲染管线） ══════════ */
  function getCell(cfg, W, H) {
    const key = `${getRev()}|${W}x${H}|${cfg.image && cfg.image.bitmap ? 'b' : 'n'}`;
    if (cellCache.key !== key) {
      cellCache.canvas = R.buildCell({ width: W, height: H }, cfg);
      cellCache.key = key;
    }
    return cellCache.canvas;
  }

  function stamp(ctx, cell, pos, cfg) {
    if (!cell) return;
    ctx.save();
    ctx.globalAlpha = U.clamp(cfg.layout.opacity / 100, 0.01, 1);
    ctx.translate(pos.x, pos.y);
    if (pos.rot) ctx.rotate(pos.rot * Math.PI / 180);
    ctx.drawImage(cell, -cell.width / 2, -cell.height / 2);
    ctx.restore();
  }

  /* ══════════ 预览挂载 ══════════ */
  function ensureMounted(item, stage, cfgGetter, revGetter) {
    getConfig = cfgGetter;
    getRev = revGetter;
    if (pv.mountedId === item.id && pv.wrap && pv.wrap.isConnected) { fit(); return; }
    unmount();
    const wrap = document.createElement('div');
    wrap.className = 'video-wrap';
    const v = document.createElement('video');
    v.src = item.url;
    v.controls = true;
    v.playsInline = true;
    const ov = document.createElement('canvas');
    ov.className = 'video-overlay';
    ov.width = item.width;
    ov.height = item.height;
    wrap.appendChild(v);
    wrap.appendChild(ov);
    stage.appendChild(wrap);
    pv.mountedId = item.id;
    pv.item = item;
    pv.wrap = wrap;
    pv.videoEl = v;
    pv.overlay = ov;
    pv.stage = stage;
    pv.vw = item.width;
    pv.vh = item.height;
    fit();
    // setTimeout 驱动（约 30fps）：窗口被遮挡/后台时 rAF 会整体冻结导致叠加层停更
    const loop = () => {
      drawOverlay();
      pv.raf = setTimeout(loop, 33);
    };
    pv.raf = setTimeout(loop, 33);
  }

  function drawOverlay() {
    const cfg = getConfig();
    if (!cfg || !pv.overlay || !pv.videoEl || !pv.item) return;
    const ctx = pv.overlay.getContext('2d');
    ctx.clearRect(0, 0, pv.overlay.width, pv.overlay.height);
    if (pv.videoEl.readyState < 2 || !pv.videoEl.videoWidth) return;
    const cell = getCell(cfg, pv.overlay.width, pv.overlay.height);
    if (!cell) return;
    const pos = positionFor(cfg, pv.item, pv.videoEl.currentTime || 0, cell, pv.overlay.width, pv.overlay.height);
    stamp(ctx, cell, pos, cfg);
  }

  function unmount() {
    if (pv.raf) clearTimeout(pv.raf);
    pv.raf = 0;
    if (pv.wrap && pv.wrap.parentNode) pv.wrap.parentNode.removeChild(pv.wrap);
    pv.mountedId = null;
    pv.item = null;
    pv.wrap = null;
    pv.videoEl = null;
    pv.overlay = null;
  }

  function isMounted(id) { return pv.mountedId === id; }

  function fit() {
    if (!pv.wrap || !pv.stage || !pv.vw) return;
    const pad = 40;
    const s = Math.min((pv.stage.clientWidth - pad) / pv.vw, (pv.stage.clientHeight - pad) / pv.vh, 1);
    pv.wrap.style.width = Math.max(80, Math.round(pv.vw * s)) + 'px';
    pv.wrap.style.height = Math.max(60, Math.round(pv.vh * s)) + 'px';
  }

  /* ══════════ 实时录制导出 ══════════ */

  /* 在用户点击手势内调用，解锁后续的音频采集 */
  function warmAudio() {
    try {
      if (!sharedActx) sharedActx = new (window.AudioContext || window.webkitAudioContext)();
      if (sharedActx.state === 'suspended') sharedActx.resume();
    } catch (e) { /* 无音频能力不阻断 */ }
  }

  const MIME_CANDIDATES = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    return MIME_CANDIDATES.find(m => {
      try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; }
    }) || '';
  }
  function extFor(type) { return (type || '').includes('mp4') ? '.mp4' : '.webm'; }

  /**
   * 实时录制：播放一遍视频的同时逐帧合成水印，时长≈原视频时长
   * @returns Blob（取消时返回 null）
   */
  async function exportRealtime(item, cfgGetter, hooks) {
    hooks = hooks || {};
    if (typeof MediaRecorder === 'undefined') throw new Error('此浏览器不支持视频录制（MediaRecorder）');
    const cfg = cfgGetter();
    if (pv.videoEl) pv.videoEl.pause(); // 导出时暂停预览播放，避免抢解码器

    const ve = document.createElement('video');
    ve.src = item.url;
    ve.playsInline = true;
    ve.preload = 'auto';
    await new Promise((res, rej) => {
      ve.onloadedmetadata = res;
      ve.onerror = () => rej(new Error('视频加载失败：' + item.name));
    });
    const W = ve.videoWidth, H = ve.videoHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const cell = getCell(cfg, W, H);

    const stream = c.captureStream(30);
    let srcNode = null;
    try {
      if (sharedActx && sharedActx.state !== 'closed') {
        srcNode = sharedActx.createMediaElementSource(ve);
        const dst = sharedActx.createMediaStreamDestination();
        srcNode.connect(dst);
        dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      }
    } catch (e) { srcNode = null; /* 无音轨继续导出画面 */ }

    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? {
      mimeType: mime,
      videoBitsPerSecond: U.clamp(W * H * 30 * 0.12, 2500000, 16000000),
    } : undefined);
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });

    const drawFrame = t => {
      ctx.drawImage(ve, 0, 0, W, H);
      if (cell) stamp(ctx, cell, positionFor(cfg, item, t, cell, W, H), cfg);
      if (cfg.noise?.enabled) R.applyNoise(ctx, W, H);
    };
    try { drawFrame(0); } catch (e) { /* 首帧未就绪，播放后接管 */ }

    rec.start(300);
    let mutedFallback = false;
    try {
      await ve.play();
    } catch (e) {
      // 自动带声播放被拦：静音起播（音轨会缺失），提前告知
      ve.muted = true;
      await ve.play();
      mutedFallback = true;
    }

    await new Promise(res => {
      ve.onended = res;
      const tick = () => {
        if (ve.ended || (hooks.isCancelled && hooks.isCancelled())) { res(); return; }
        try { drawFrame(ve.currentTime); } catch (e) { /* 偶发帧未就绪，跳过 */ }
        if (hooks.onProgress) hooks.onProgress(ve.currentTime, ve.duration);
        setTimeout(tick, 30); // 不用 rAF：标签页不可见时 rAF 会冻结
      };
      tick();
    });
    ve.pause();
    await new Promise(r => setTimeout(r, 200)); // 留出编码器收尾时间
    try { rec.stop(); } catch (e) { /* 已停止 */ }
    await stopped;
    try { if (srcNode) srcNode.disconnect(); } catch (e) { /* 清理 */ }
    ve.removeAttribute('src');
    ve.load();

    if (hooks.isCancelled && hooks.isCancelled()) return null;
    if (mutedFallback && hooks.onWarn) hooks.onWarn('浏览器限制了声音播放，本次导出可能没有音轨');
    return new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  }

  return { probe, ensureMounted, unmount, isMounted, fit, warmAudio, exportRealtime, extFor, isVideoFile };
})();

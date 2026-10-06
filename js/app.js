/* ══════════════════════════════════════════════
   app.js — 应用主逻辑
   上传队列 / 实时预览 / 拖拽定位 / 配置绑定 /
   预设管理 / 批量导出
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  const U = WM.utils;
  const R = WM.renderer;
  const P = WM.presets;

  const $ = U.$;

  /* ══════════ 状态 ══════════ */
  const state = {
    images: [],            // 图片项 {kind:'image', id, name, file, canvas, width, height, exif, thumbURL}
                           // 视频项 {kind:'video', id, name, file, url, width, height, duration, thumbURL}
    currentId: null,
    config: P.defaultConfig(),
    configRev: 0,          // 每次配置变化 +1，视频水印单元据此重建缓存
    presetId: 'tile-diagonal',
    zoomMode: 'fit',
    zoom: 1,
    exporting: false,
    cancelExport: false,
    idSeq: 1,
    loading: 0,            // 正在解码的文件数（>0 时禁用导出，防止导出半截队列）
  };
  const LS_THEME = 'wm-theme';
  const LS_PRESETS = 'wm-mypresets';
  const LS_CONFIG = 'wm-lastconfig';

  /* ══════════ DOM 引用 ══════════ */
  const el = {
    dropZone: $('#dropZone'), fileInput: $('#fileInput'),
    fileQueue: $('#fileQueue'), queueCount: $('#queueCount'),
    btnClearQueue: $('#btnClearQueue'), queueEmptyHint: $('#queueEmptyHint'),
    previewCanvas: $('#previewCanvas'), previewStage: $('#previewStage'),
    emptyHint: $('#emptyHint'), dragHint: $('#dragHint'),
    btnPrevImg: $('#btnPrevImg'), btnNextImg: $('#btnNextImg'), curLabel: $('#curLabel'),
    btnCompare: $('#btnCompare'),
    btnZoomIn: $('#btnZoomIn'), btnZoomOut: $('#btnZoomOut'), zoomLabel: $('#zoomLabel'),
    statusText: $('#statusText'), statusRight: $('#statusRight'),
    presetGrid: $('#presetGrid'), myPresetGrid: $('#myPresetGrid'),
    btnSavePreset: $('#btnSavePreset'), presetTag: $('#presetTag'),
    toast: $('#toast'),
    progressOverlay: $('#progressOverlay'), progressBar: $('#progressBar'),
    progressText: $('#progressText'), btnCancelExport: $('#btnCancelExport'),
    btnExportZip: $('#btnExportZip'), btnExportCurrent: $('#btnExportCurrent'),
    btnTheme: $('#btnTheme'), btnFillExif: $('#btnFillExif'),
    btnCopyright: $('#btnCopyright'),
    imgDrop: $('#imgDrop'), imgInput: $('#imgInput'),
    imgWatermarkPreview: $('#imgWatermarkPreview'), imgDropHint: $('#imgDropHint'),
    textCardBody: $('#textCardBody'), imgCardBody: $('#imgCardBody'),
    rotateField: $('#rotateField'), anchorGrid: $('#anchorGrid'),
    layoutSingle: $('#layoutSingle'), layoutTile: $('#layoutTile'),
    layoutRandom: $('#layoutRandom'), layoutBar: $('#layoutBar'),
  };

  const currentImage = () => state.images.find(i => i.id === state.currentId) || null;

  /* ══════════ 初始化 ══════════ */
  initTheme();
  buildFontSelect();
  buildAnchorGrid();
  buildPresetGrid();
  loadMyPresets();
  restoreLastConfig();
  bindUpload();
  bindNavigation();
  bindConfigControls();
  bindPreviewInteractions();
  bindExport();
  syncUI();
  updateQueueUI();
  setStatus('就绪，等待上传图片');

  /* ══════════ 主题 ══════════ */
  function initTheme() {
    const saved = localStorage.getItem(LS_THEME);
    const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    el.btnTheme.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem(LS_THEME, next);
    });
  }

  /* ══════════ 字体下拉 ══════════ */
  function buildFontSelect() {
    const sel = $('#textFont');
    P.FONTS.forEach(f => {
      const o = document.createElement('option');
      o.value = f.value;
      o.textContent = f.label;
      o.style.fontFamily = f.value;
      sel.appendChild(o);
    });
  }

  /* ══════════ 九宫格 ══════════ */
  function buildAnchorGrid() {
    for (let i = 0; i < 9; i++) {
      const b = document.createElement('button');
      b.dataset.v = i;
      b.setAttribute('aria-label', '位置 ' + (i + 1));
      b.addEventListener('click', () => {
        state.config.layout.anchor = i;
        state.config.layout.offX = 0;
        state.config.layout.offY = 0;
        markCustom();
        syncAnchor();
        schedulePreview();
      });
      el.anchorGrid.appendChild(b);
    }
  }
  function syncAnchor() {
    U.$$('button', el.anchorGrid).forEach(b =>
      b.classList.toggle('active', +b.dataset.v === state.config.layout.anchor));
  }

  /* ══════════ 上传 ══════════ */
  function bindUpload() {
    el.dropZone.addEventListener('click', () => el.fileInput.click());
    el.dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') el.fileInput.click(); });
    el.fileInput.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

    // 全窗口拖拽（支持文件夹）
    let dragDepth = 0;
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('dragenter', e => {
      e.preventDefault();
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        dragDepth++;
        el.dragHint.hidden = false;
      }
    });
    window.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) { dragDepth = 0; el.dragHint.hidden = true; }
    });
    window.addEventListener('drop', async e => {
      e.preventDefault();
      dragDepth = 0;
      el.dragHint.hidden = true;
      const files = await collectDroppedFiles(e.dataTransfer);
      if (files.length) addFiles(files);
    });
    // 粘贴上传：截图 / 在资源管理器里复制的图片与视频文件，Ctrl+V 即可
    document.addEventListener('paste', e => {
      const files = Array.from(e.clipboardData?.files || []).filter(isMediaFile);
      if (files.length) { addFiles(files); U.toast(`已粘贴 ${files.length} 个文件`); }
    });

    el.btnClearQueue.addEventListener('click', () => {
      state.images.forEach(i => { if (i.kind === 'video') URL.revokeObjectURL(i.url); });
      WM.video.unmount();
      state.images = [];
      state.currentId = null;
      updateQueueUI();
      renderPreviewCanvas();
      setStatus('已清空队列');
    });
  }

  /* 递归收集拖入的文件（含文件夹），图片与视频都要 */
  const isMediaFile = f => f.type.startsWith('image/') || f.type.startsWith('video/');
  async function collectDroppedFiles(dt) {
    const out = [];
    const items = Array.from(dt.items || []);
    const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) {
      await Promise.all(entries.map(en => walkEntry(en, out)));
      if (out.length) return out.filter(isMediaFile);
    }
    return Array.from(dt.files || []).filter(isMediaFile);
  }
  function walkEntry(entry, out) {
    return new Promise(res => {
      if (entry.isFile) {
        entry.file(f => { out.push(f); res(); }, () => res());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries(async subs => {
          if (!subs.length) return res();
          await Promise.all(subs.map(s => walkEntry(s, out)));
          readBatch(); // 目录条目多时需分批读
        }, () => res());
        readBatch();
      } else res();
    });
  }

  async function addFiles(fileList) {
    const isMedia = f => f.type.startsWith('image/') || f.type.startsWith('video/');
    const files = Array.from(fileList).filter(isMedia);
    const skipped = fileList.length - files.length;
    if (!files.length) { U.toast('没有可用的图片或视频文件', true); return; }

    setStatus(`正在读取 ${files.length} 个文件…`);
    state.loading++;
    el.btnExportZip.disabled = true;
    el.btnExportCurrent.disabled = true;
    const results = await Promise.allSettled(files.map(async f => {
      if (f.type.startsWith('video/')) {
        return { f, video: await WM.video.probe(f) };
      }
      const buf = await f.arrayBuffer();
      const exif = WM.exif.parse(buf);
      const canvas = await U.decodeImageFile(f, exif);
      return { f, exif, canvas };
    }));

    let added = 0, firstNewId = null;
    for (const r of results) {
      if (r.status !== 'fulfilled') { console.warn(r.reason); continue; }
      const { f } = r.value;
      const item = r.value.video ? {
        id: 'img' + (state.idSeq++),
        name: f.name || 'video.mp4',
        file: f,
        kind: 'video',
        url: r.value.video.url,
        width: r.value.video.width,
        height: r.value.video.height,
        duration: r.value.video.duration,
        thumbURL: r.value.video.thumbURL,
        exif: null,
      } : {
        id: 'img' + (state.idSeq++),
        name: f.name || 'clipboard.png',
        file: f,
        kind: 'image',
        canvas: r.value.canvas,
        width: r.value.canvas.width,
        height: r.value.canvas.height,
        exif: r.value.exif,
        thumbURL: makeThumb(r.value.canvas),
      };
      state.images.push(item);
      added++;
      if (!firstNewId) firstNewId = item.id;
    }
    if (state.currentId === null && firstNewId) state.currentId = firstNewId;
    state.loading--;
    updateQueueUI();
    renderPreviewCanvas();
    const extra = skipped > 0 ? `，已跳过 ${skipped} 个不支持的文件` : '';
    setStatus(added ? `已添加 ${added} 个文件${extra}` : '添加失败：媒体无法解码');
    if (!added) U.toast('文件解码失败，请换文件试试', true);
  }

  function makeThumb(canvas) {
    const t = document.createElement('canvas');
    const s = 88 / Math.max(canvas.width, canvas.height);
    t.width = Math.max(1, Math.round(canvas.width * s));
    t.height = Math.max(1, Math.round(canvas.height * s));
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.7);
  }

  /* ══════════ 队列 UI ══════════ */
  function updateQueueUI() {
    el.queueCount.textContent = state.images.length;
    el.btnClearQueue.hidden = state.images.length === 0;
    el.queueEmptyHint.hidden = state.images.length !== 0;
    el.btnExportZip.disabled = state.images.length === 0 || state.loading > 0;
    el.btnExportCurrent.disabled = !currentImage() || state.loading > 0;
    el.btnCompare.disabled = !currentImage();

    el.fileQueue.querySelectorAll('.queue-item').forEach(n => n.remove());
    const frag = document.createDocumentFragment();
    state.images.forEach(img => {
      const li = document.createElement('li');
      li.className = 'queue-item' + (img.id === state.currentId ? ' active' : '');
      li.innerHTML = `
        <img class="queue-thumb" src="${img.thumbURL}" alt="">
        <div class="queue-meta">
          <div class="queue-name" title="${U.escapeHtml(img.name)}">${U.escapeHtml(img.name)}</div>
          <div class="queue-dim">${img.width}×${img.height}${img.kind === 'video' ? ' · ' + fmtDur(img.duration) + ' 视频' : ''}</div>
        </div>
        <button class="queue-del" title="移除" aria-label="移除">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>`;
      li.addEventListener('click', e => {
        if (e.target.closest('.queue-del')) {
          removeImage(img.id);
        } else {
          state.currentId = img.id;
          updateQueueUI();
          renderPreviewCanvas();
        }
      });
      frag.appendChild(li);
    });
    el.fileQueue.appendChild(frag);
    updateStatusRight();
  }

  function removeImage(id) {
    const idx = state.images.findIndex(i => i.id === id);
    if (idx < 0) return;
    const [rm] = state.images.splice(idx, 1);
    if (rm.kind === 'video') {
      if (WM.video.isMounted(rm.id)) WM.video.unmount();
      URL.revokeObjectURL(rm.url);
    }
    if (state.currentId === id) {
      state.currentId = state.images[Math.min(idx, state.images.length - 1)]?.id || null;
    }
    updateQueueUI();
    renderPreviewCanvas();
  }

  /* 秒 → m:ss */
  function fmtDur(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /* ══════════ 导航 / 缩放 / 对比 ══════════ */
  function bindNavigation() {
    el.btnPrevImg.addEventListener('click', () => stepImage(-1));
    el.btnNextImg.addEventListener('click', () => stepImage(1));
    el.btnZoomIn.addEventListener('click', () => setZoom(state.zoom * 1.25));
    el.btnZoomOut.addEventListener('click', () => setZoom(state.zoom / 1.25));
    el.zoomLabel.addEventListener('click', () => { state.zoomMode = 'fit'; fitPreview(); });
    el.previewCanvas.addEventListener('dblclick', () => { state.zoomMode = 'fit'; fitPreview(); });

    const startCompare = e => { e.preventDefault(); renderPreviewCanvas(false); };
    const endCompare = () => renderPreviewCanvas(true);
    el.btnCompare.addEventListener('pointerdown', startCompare);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
      el.btnCompare.addEventListener(ev, endCompare));

    let resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { if (state.zoomMode === 'fit') fitPreview(); }, 80);
    });
  }

  function stepImage(d) {
    if (!state.images.length) return;
    const idx = state.images.findIndex(i => i.id === state.currentId);
    const next = (idx + d + state.images.length) % state.images.length;
    state.currentId = state.images[next].id;
    updateQueueUI();
    renderPreviewCanvas();
  }

  function setZoom(z) {
    state.zoom = U.clamp(z, 0.05, 8);
    state.zoomMode = 'manual';
    el.previewCanvas.style.width = (currentImage()?.width || 100) * state.zoom + 'px';
    updateZoomLabel();
  }
  function updateZoomLabel() {
    const img = currentImage();
    if (!img) { el.zoomLabel.textContent = '100%'; return; }
    const shown = el.previewCanvas.clientWidth / img.width;
    el.zoomLabel.textContent = Math.round(shown * 100) + '%';
  }

  /* ══════════ 预览渲染 ══════════ */
  const schedulePreview = U.debounce(() => renderPreviewCanvas(), 70);

  function renderPreviewCanvas(withWatermark = true) {
    const img = currentImage();
    el.emptyHint.hidden = !!img;
    el.curLabel.textContent = img ? img.name : '—';
    if (!img) {
      el.previewCanvas.hidden = true;
      WM.video.unmount();
      updateMediaControls(false);
      updateStatusRight();
      return;
    }
    if (img.kind === 'video') {
      // 视频走叠加层实时渲染（rAF 循环直接读最新 config），无需重绘画布
      el.previewCanvas.hidden = true;
      WM.video.ensureMounted(img, el.previewStage, () => state.config, () => state.configRev);
      updateMediaControls(false);
      el.zoomLabel.textContent = '适配';
      updateStatusRight();
      return;
    }
    WM.video.unmount();
    el.previewCanvas.hidden = false;
    updateMediaControls(true);
    const out = R.render(img, state.config, { withWatermark });
    const c = el.previewCanvas;
    c.width = out.width; c.height = out.height;
    c.getContext('2d').drawImage(out, 0, 0);
    if (state.zoomMode === 'fit') fitPreview(); else setZoom(state.zoom);
    updateStatusRight();
  }

  /* 视频：对比/缩放不可用；图片：全部可用 */
  function updateMediaControls(isImage) {
    el.btnCompare.disabled = !isImage;
    el.btnZoomIn.disabled = !isImage;
    el.btnZoomOut.disabled = !isImage;
    if (!isImage) el.zoomLabel.textContent = '适配';
  }

  function fitPreview() {
    const img = currentImage();
    if (!img) return;
    if (img.kind === 'video') { WM.video.fit(); return; }
    const pad = 40;
    const sw = el.previewStage.clientWidth - pad;
    const sh = el.previewStage.clientHeight - pad;
    const scale = Math.min(sw / img.width, sh / img.height, 1);
    el.previewCanvas.style.width = img.width * scale + 'px';
    updateZoomLabel();
  }

  function updateStatusRight() {
    const img = currentImage();
    if (!img) { el.statusRight.textContent = ''; return; }
    const kind = img.file?.type || '';
    const type = kind.replace(/(image|video)\//, '').toUpperCase() || 'FILE';
    const dur = img.kind === 'video' ? ` · ${fmtDur(img.duration)}` : '';
    el.statusRight.textContent = `${img.width}×${img.height}${dur} · ${U.formatBytes(img.file?.size || 0)} · ${type}`;
  }

  function setStatus(s) { el.statusText.textContent = s; }

  /* ══════════ 画布拖拽水印（single 模式） ══════════ */
  function bindPreviewInteractions() {
    const c = el.previewCanvas;
    let dragging = null;

    c.addEventListener('pointerdown', e => {
      const img = currentImage();
      if (!img || img.kind !== 'image' || state.config.layout.mode !== 'single') return;
      const hit = R.singleHitRect(img, state.config);
      if (!hit) return;
      const p = toImagePos(e);
      const rad = -hit.rotate * Math.PI / 180;
      const dx = p.x - hit.cx, dy = p.y - hit.cy;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(lx) > hit.w / 2 * 1.35 || Math.abs(ly) > hit.h / 2 * 1.35) return;

      dragging = {
        startPx: p, startOffX: state.config.layout.offX, startOffY: state.config.layout.offY,
      };
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* 合成/丢失指针时忽略 */ }
      c.classList.add('dragging');
    });

    c.addEventListener('pointermove', e => {
      if (!dragging) return;
      const img = currentImage();
      if (!img) return;
      const p = toImagePos(e);
      state.config.layout.offX = dragging.startOffX + (p.x - dragging.startPx.x) / img.width * 100;
      state.config.layout.offY = dragging.startOffY + (p.y - dragging.startPx.y) / img.height * 100;
      schedulePreview();
    });

    ['pointerup', 'pointercancel'].forEach(ev => c.addEventListener(ev, () => {
      if (dragging) markCustom();
      dragging = null;
      c.classList.remove('dragging');
    }));

    // 悬停时在单个模式下提示可拖动
    c.addEventListener('pointermove', () => {
      if (state.config.layout.mode === 'single') c.classList.add('draggable-mark');
      else c.classList.remove('draggable-mark');
    });
  }

  function toImagePos(e) {
    const img = currentImage();
    const r = el.previewCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * img.width,
      y: (e.clientY - r.top) / r.height * img.height,
    };
  }

  /* ══════════ 配置控件绑定（控件 → config） ══════════ */
  function bindConfigControls() {
    const on = (id, evt, fn) => $(id).addEventListener(evt, fn);

    // —— 文字水印 ——
    on('#textEnabled', 'change', e => {
      state.config.text.enabled = e.target.checked;
      el.textCardBody.classList.toggle('dim', !e.target.checked);
      markCustom(); schedulePreview();
    });
    on('#textText', 'input', e => { state.config.text.content = e.target.value; markCustom(); schedulePreview(); });
    on('#textFont', 'change', e => { state.config.text.fontStack = e.target.value; markCustom(); schedulePreview(); });
    bindRange('#textSize', v => state.config.text.sizePct = v, '#textSizeOut', v => v.toFixed(1));
    on('#textColor', 'input', e => { state.config.text.color = e.target.value; markCustom(); schedulePreview(); });
    on('#textAutoColor', 'change', e => { state.config.text.autoColor = e.target.checked; markCustom(); schedulePreview(); });
    on('#textWeight', 'change', e => { state.config.text.weight = +e.target.value; markCustom(); schedulePreview(); });
    on('#textItalic', 'change', e => { state.config.text.italic = e.target.checked; markCustom(); schedulePreview(); });
    on('#btnCopyright', 'click', () => {
      const t = $('#textText');
      t.value = (t.value + ' ©').trim();
      t.dispatchEvent(new Event('input'));
    });
    bindToggle('#strokeOn', v => { state.config.text.stroke.enabled = v; $('#strokeRow').hidden = !v; });
    on('#strokeColor', 'input', e => { state.config.text.stroke.color = e.target.value; markCustom(); schedulePreview(); });
    on('#strokeWidth', 'input', e => { state.config.text.stroke.width = +e.target.value; markCustom(); schedulePreview(); });
    bindToggle('#shadowOn', v => { state.config.text.shadow.enabled = v; $('#shadowRow').hidden = !v; });
    on('#shadowColor', 'input', e => { state.config.text.shadow.color = e.target.value; markCustom(); schedulePreview(); });
    bindRange('#shadowBlur', v => state.config.text.shadow.blur = v);
    bindToggle('#bgOn', v => { state.config.text.bg.enabled = v; $('#bgRow').hidden = !v; });
    on('#bgColor', 'input', e => { state.config.text.bg.color = e.target.value; markCustom(); schedulePreview(); });
    bindRange('#bgOpacity', v => state.config.text.bg.opacity = v);

    // —— 图片水印 ——
    on('#imgEnabled', 'change', e => {
      state.config.image.enabled = e.target.checked;
      refreshImageCard();
      markCustom(); schedulePreview();
    });
    el.imgDrop.addEventListener('click', () => el.imgInput.click());
    el.imgDrop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') el.imgInput.click(); });
    el.imgInput.addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        state.config.image.bitmap = await U.decodeImageFile(f);
        state.config.image.enabled = true;
        refreshImageCard();
        markCustom(); schedulePreview();
        U.toast('水印图已更新');
      } catch (err) { U.toast('水印图读取失败', true); }
    });
    bindRange('#imgScale', v => state.config.image.scalePct = v, '#imgScaleOut', v => String(Math.round(v)));
    on('#imgShape', 'change', e => { state.config.image.shape = e.target.value; markCustom(); schedulePreview(); });
    bindRange('#imgMargin', v => state.config.image.margin = v);

    // —— 布局模式 ——
    U.$$('#layoutMode button').forEach(b => b.addEventListener('click', () => {
      state.config.layout.mode = b.dataset.v;
      markCustom();
      syncLayoutPanels();
      schedulePreview();
    }));

    bindRange('#tileAngle', v => state.config.layout.tileAngle = v, '#tileAngleOut', v => String(Math.round(v)));
    bindRange('#gapX', v => state.config.layout.gapX = v, '#gapXOut', v => v.toFixed(1));
    bindRange('#gapY', v => state.config.layout.gapY = v, '#gapYOut', v => v.toFixed(1));
    on('#tileStagger', 'change', e => { state.config.layout.stagger = e.target.checked; markCustom(); schedulePreview(); });

    bindRange('#randCount', v => state.config.layout.randCount = v, '#randCountOut', v => String(Math.round(v)), 1);
    bindRange('#randJitter', v => state.config.layout.randJitter = v, '#randJitterOut', v => String(Math.round(v)), 5);
    on('#randAvoidCenter', 'change', e => { state.config.layout.avoidCenter = e.target.checked; markCustom(); schedulePreview(); });

    // —— 参数条 ——
    [['#barBrand', 'brand'], ['#barModel', 'model'], ['#barParams', 'params'], ['#barDate', 'date']].forEach(([id, key]) => {
      on(id, 'input', e => { state.config.bar[key] = e.target.value; markCustom(); schedulePreview(); });
    });
    bindRange('#barHeight', v => state.config.bar.heightPct = v, '#barHeightOut', v => v.toFixed(1), 0.5);
    bindRange('#barOpacity', v => state.config.bar.opacity = v, '#barOpacityOut', v => String(Math.round(v)), 5);
    on('#barLogo', 'change', e => { state.config.bar.useLogo = e.target.checked; markCustom(); schedulePreview(); });
    el.btnFillExif.addEventListener('click', fillExifFromPhoto);

    // —— 视频运动 ——
    U.$$('#videoMode button').forEach(b => b.addEventListener('click', () => {
      state.config.video.mode = b.dataset.v;
      markCustom();
      syncVideoPanels();
    }));
    bindRange('#vidAmp', v => state.config.video.amp = v, '#vidAmpOut', v => String(Math.round(v)), 5);
    bindRange('#vidSpeed', v => state.config.video.speed = v, '#vidSpeedOut', v => v.toFixed(1));
    bindRange('#vidHop', v => state.config.video.hopInterval = v, '#vidHopOut', v => String(Math.round(v)));
    on('#vidHopSmooth', 'change', e => { state.config.video.hopSmooth = e.target.checked; markCustom(); });

    // —— 通用 ——
    bindRange('#opacity', v => state.config.layout.opacity = v, '#opacityOut', v => String(Math.round(v)));
    bindRange('#rotate', v => state.config.layout.rotate = v, '#rotateOut', v => String(Math.round(v)));
  }

  function bindRange(id, set, outId, fmt = v => String(Math.round(v)), step) {
    const input = $(id);
    input.addEventListener('input', e => {
      const v = +e.target.value;
      set(v);
      if (outId) $(outId).textContent = fmt(v);
      markCustom();
      schedulePreview();
    });
  }
  function bindToggle(id, set) {
    $(id).addEventListener('change', e => { set(e.target.checked); markCustom(); schedulePreview(); });
  }

  function refreshImageCard() {
    const has = !!state.config.image.bitmap;
    el.imgCardBody.classList.toggle('dim', !state.config.image.enabled);
    $('#imgEnabled').checked = state.config.image.enabled;
    el.imgWatermarkPreview.hidden = !has;
    if (has) el.imgWatermarkPreview.src = state.config.image.bitmap.toDataURL();
    el.imgDropHint.hidden = has;
    el.imgDrop.classList.toggle('has-img', has);
    el.imgDropHint.textContent = has ? '点击更换' : '点击选择 PNG 水印图';
  }

  /* 参数条自动填充 */
  function fillExifFromPhoto() {
    const img = currentImage();
    const ex = img?.exif;
    if (!ex || (!ex.make && !ex.model && !ex.fNumber && !ex.iso)) {
      U.toast('这张图没有拍摄信息（EXIF），可手动填写', true);
      return;
    }
    const B = state.config.bar;
    if (ex.make) B.brand = ex.make;
    if (ex.model) B.model = ex.model;
    const params = WM.exif.formatParams(ex);
    if (params) B.params = params;
    const date = WM.exif.formatDate(ex);
    if (date) B.date = date;
    if (!state.config.layout.mode || state.config.layout.mode !== 'bar') {
      state.config.layout.mode = 'bar';
    }
    syncUI();
    schedulePreview();
    saveConfigDebounced();
    U.toast('已从照片信息填充');
  }

  /* ══════════ 预设 ══════════ */
  function buildPresetGrid() {
    P.PRESETS.forEach(p => {
      const card = document.createElement('button');
      card.className = 'preset-card';
      card.dataset.id = p.id;
      card.innerHTML = `<span class="demo ${p.demo}"></span>
        <span class="p-name">${p.name}</span>
        <p class="p-desc">${p.desc}</p>`;
      card.addEventListener('click', () => applyPreset(p.id));
      el.presetGrid.appendChild(card);
    });
  }

  function applyPreset(id) {
    const preset = P.PRESETS.find(p => p.id === id);
    if (!preset) return;
    const keepVideo = state.config.video; // 视频运动设置不属于画面样式
    const cfg = P.apply(preset, state.config);
    cfg.video = keepVideo;
    state.config = cfg;
    state.presetId = id;
    state.configRev++;
    syncUI();
    schedulePreview();
    setStatus(`已应用预设「${preset.name}」（文字与图片保持不变）`);
    if (preset.id === 'avatar-stamp' && !cfg.image.bitmap) {
      U.toast('提示：在「图片水印」处上传头像图片');
    }
    if (preset.id === 'photo-bar') {
      U.toast('提示：点「从照片信息自动填充」可读取拍摄参数');
    }
  }

  function markCustom() {
    state.configRev++;
    if (state.presetId !== null) {
      state.presetId = null;
      highlightPresetCards();
      el.presetTag.textContent = '自定义';
    }
    saveConfigDebounced();
  }

  function highlightPresetCards() {
    U.$$('.preset-card', el.presetGrid).forEach(c =>
      c.classList.toggle('active', c.dataset.id === state.presetId));
    if (state.presetId) {
      const p = P.PRESETS.find(x => x.id === state.presetId);
      el.presetTag.textContent = p ? p.name : '自定义';
    }
  }

  /* 我的预设 */
  function getMyPresets() {
    try { return JSON.parse(localStorage.getItem(LS_PRESETS) || '[]'); } catch (e) { return []; }
  }
  function setMyPresets(list) {
    localStorage.setItem(LS_PRESETS, JSON.stringify(list));
    renderMyPresets();
  }
  function loadMyPresets() { renderMyPresets(); }
  function renderMyPresets() {
    const list = getMyPresets();
    el.myPresetGrid.hidden = list.length === 0;
    el.myPresetGrid.innerHTML = '';
    list.forEach(mp => {
      const card = document.createElement('button');
      card.className = 'preset-card';
      card.innerHTML = `<span class="demo d-tile-diagonal"></span>
        <span class="p-name">${U.escapeHtml(mp.name)}</span>
        <p class="p-desc">我的预设</p>
        <span class="queue-del my-del" title="删除">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </span>`;
      card.addEventListener('click', e => {
        if (e.target.closest('.my-del')) {
          setMyPresets(getMyPresets().filter(x => x.id !== mp.id));
          U.toast('已删除预设');
          return;
        }
        // 全量快照恢复：文字、字体、颜色、图片、视频运动等一切参数
        state.config = P.merge(P.defaultConfig(), mp.config);
        state.presetId = null;
        state.configRev++;
        highlightPresetCards();
        el.presetTag.textContent = mp.name;
        syncUI();
        schedulePreview();
        setStatus(`已应用「${mp.name}」（全部参数已恢复）`);
        if (mp.config.image?.dataURL) {
          decodeSnapshotBitmap(mp.config.image.dataURL).then(canvas => {
            if (state.config.image && !state.config.image.bitmap) {
              state.config.image.bitmap = canvas;
              refreshImageCard();
              schedulePreview();
            }
          }).catch(() => { /* 位图恢复失败忽略 */ });
        }
      });
      el.myPresetGrid.appendChild(card);
    });
  }
  /* ══════════ 全量快照（我的预设 / 上次配置共用） ══════════ */

  /* 位图 dataURL 字符长度上限，防止撑爆 localStorage 配额 */
  const SNAP_IMG_LIMIT = 1400 * 1024;
  const bitmapDecodeCache = new Map(); // dataURL → canvas

  /* 配置 → 可持久化快照：位图转 dataURL 一并存下 */
  function snapshotConfig(cfg) {
    const snapshot = JSON.parse(JSON.stringify({ ...cfg, image: { ...cfg.image, bitmap: null } }));
    let imgTooBig = false;
    if (cfg.image.bitmap) {
      try {
        const url = cfg.image.bitmap.toDataURL('image/png');
        if (url.length <= SNAP_IMG_LIMIT) snapshot.image.dataURL = url;
        else imgTooBig = true;
      } catch (e) { imgTooBig = true; }
    }
    return { snapshot, imgTooBig };
  }

  /* 快照 dataURL → 位图 canvas（带缓存） */
  async function decodeSnapshotBitmap(url) {
    if (bitmapDecodeCache.has(url)) return bitmapDecodeCache.get(url);
    const blob = await (await fetch(url)).blob();
    const canvas = await U.decodeImageFile(blob);
    bitmapDecodeCache.set(url, canvas);
    if (bitmapDecodeCache.size > 8) bitmapDecodeCache.delete(bitmapDecodeCache.keys().next().value);
    return canvas;
  }

  el.btnSavePreset.addEventListener('click', () => {
    const { snapshot, imgTooBig } = snapshotConfig(state.config);
    const list = getMyPresets();
    list.push({
      id: 'my' + Date.now(),
      name: '我的预设 ' + (list.length + 1),
      config: snapshot,
    });
    try {
      setMyPresets(list);
      U.toast(imgTooBig
        ? '水印图片过大未存入预设，其余参数已全部保存'
        : '已保存为我的预设（文字、图片等全部参数）');
    } catch (e) {
      list.pop();
      renderMyPresets();
      U.toast('保存失败：浏览器本地存储空间不足', true);
    }
  });

  /* 上次配置记忆（同样保留水印图片） */
  const saveConfigDebounced = U.debounce(() => {
    try {
      const { snapshot } = snapshotConfig(state.config);
      localStorage.setItem(LS_CONFIG, JSON.stringify(snapshot));
    } catch (e) { /* 配额不足时静默跳过 */ }
  }, 900);
  function restoreLastConfig() {
    try {
      const raw = localStorage.getItem(LS_CONFIG);
      if (!raw) return;
      const saved = JSON.parse(raw);
      state.config = P.merge(P.defaultConfig(), saved);
      state.presetId = null; // 恢复视为自定义
      state.configRev++;
      if (saved.image?.dataURL) {
        decodeSnapshotBitmap(saved.image.dataURL).then(canvas => {
          if (state.config.image && !state.config.image.bitmap) {
            state.config.image.bitmap = canvas;
            refreshImageCard();
            schedulePreview();
          }
        }).catch(() => { /* 位图恢复失败不影响其余 */ });
      }
    } catch (e) { /* 损坏则用默认 */ }
  }

  /* ══════════ config → 控件（syncUI） ══════════ */
  function syncUI() {
    const t = state.config.text, im = state.config.image, L = state.config.layout, B = state.config.bar, V = state.config.video;

    $('#textEnabled').checked = t.enabled;
    el.textCardBody.classList.toggle('dim', !t.enabled);
    $('#textText').value = t.content;
    $('#textFont').value = t.fontStack;
    setRange('#textSize', t.sizePct, '#textSizeOut', v => v.toFixed(1));
    $('#textColor').value = normalizeHex(t.color);
    $('#textAutoColor').checked = t.autoColor;
    $('#textWeight').value = String(t.weight);
    $('#textItalic').checked = t.italic;
    $('#strokeOn').checked = t.stroke.enabled;
    $('#strokeRow').hidden = !t.stroke.enabled;
    $('#strokeColor').value = normalizeHex(t.stroke.color);
    setRange('#strokeWidth', t.stroke.width);
    $('#shadowOn').checked = t.shadow.enabled;
    $('#shadowRow').hidden = !t.shadow.enabled;
    $('#shadowColor').value = normalizeHex(t.shadow.color);
    setRange('#shadowBlur', t.shadow.blur);
    $('#bgOn').checked = t.bg.enabled;
    $('#bgRow').hidden = !t.bg.enabled;
    $('#bgColor').value = normalizeHex(t.bg.color);
    setRange('#bgOpacity', t.bg.opacity);

    $('#imgEnabled').checked = im.enabled;
    setRange('#imgScale', im.scalePct, '#imgScaleOut', v => String(Math.round(v)));
    $('#imgShape').value = im.shape;
    setRange('#imgMargin', im.margin);
    refreshImageCard();

    syncLayoutPanels();
    U.$$('#layoutMode button').forEach(b =>
      b.classList.toggle('active', b.dataset.v === L.mode));

    setRange('#tileAngle', L.tileAngle, '#tileAngleOut', v => String(Math.round(v)));
    setRange('#gapX', L.gapX, '#gapXOut', v => v.toFixed(1));
    setRange('#gapY', L.gapY, '#gapYOut', v => v.toFixed(1));
    $('#tileStagger').checked = L.stagger;
    setRange('#randCount', L.randCount, '#randCountOut', v => String(Math.round(v)));
    setRange('#randJitter', L.randJitter, '#randJitterOut', v => String(Math.round(v)));
    $('#randAvoidCenter').checked = L.avoidCenter;

    $('#barBrand').value = B.brand || '';
    $('#barModel').value = B.model || '';
    $('#barParams').value = B.params || '';
    $('#barDate').value = B.date || '';
    setRange('#barHeight', B.heightPct, '#barHeightOut', v => v.toFixed(1));
    setRange('#barOpacity', B.opacity, '#barOpacityOut', v => String(Math.round(v)));
    $('#barLogo').checked = B.useLogo;

    setRange('#vidAmp', V.amp, '#vidAmpOut', v => String(Math.round(v)));
    setRange('#vidSpeed', V.speed, '#vidSpeedOut', v => v.toFixed(1));
    setRange('#vidHop', V.hopInterval, '#vidHopOut', v => String(Math.round(v)));
    $('#vidHopSmooth').checked = V.hopSmooth;
    syncVideoPanels();

    setRange('#opacity', L.opacity, '#opacityOut', v => String(Math.round(v)));
    setRange('#rotate', L.rotate, '#rotateOut', v => String(Math.round(v)));

    syncAnchor();
    highlightPresetCards();
  }

  /* 视频运动子面板：与分段按钮联动 */
  function syncVideoPanels() {
    const m = state.config.video.mode;
    $('#videoFloat').hidden = m !== 'float';
    $('#videoHop').hidden = m !== 'hop';
    $('#videoFixedHint').hidden = m !== 'fixed';
    const tag = $('#videoModeTag');
    if (tag) tag.textContent = { fixed: '固定', float: '漂浮', hop: '跳位' }[m] || m;
    U.$$('#videoMode button').forEach(b =>
      b.classList.toggle('active', b.dataset.v === m));
  }

  function setRange(id, v, outId, fmt) {
    const input = $(id);
    input.value = v;
    if (outId) $(outId).textContent = fmt ? fmt(+v) : String(Math.round(+v));
  }

  /* rgba() → #rrggbb（输入框只接受 hex） */
  function normalizeHex(c) {
    const m = /^#([0-9a-f]{6})$/i.exec(c || '');
    return m ? c : '#ffffff';
  }

  function syncLayoutPanels() {
    const mode = state.config.layout.mode;
    el.layoutSingle.hidden = mode !== 'single';
    el.layoutTile.hidden = mode !== 'tile';
    el.layoutRandom.hidden = mode !== 'random';
    el.layoutBar.hidden = mode !== 'bar';
    el.rotateField.hidden = !(mode === 'single' || mode === 'random');
    U.$$('#layoutMode button').forEach(b =>
      b.classList.toggle('active', b.dataset.v === mode));
  }

  /* ══════════ 导出 ══════════ */
  function bindExport() {
    el.btnExportZip.addEventListener('click', () => { WM.video.warmAudio(); runExport(state.images.slice(), true); });
    el.btnExportCurrent.addEventListener('click', () => { WM.video.warmAudio(); runExport([currentImage()].filter(Boolean), false); });
    el.btnCancelExport.addEventListener('click', () => { state.cancelExport = true; });
  }

  function resolveMime(img) {
    const fmt = $('#expFormat').value;
    if (fmt !== 'keep') return fmt;
    const t = img.file?.type || '';
    if (t === 'image/jpeg' || t === 'image/png' || t === 'image/webp') return t;
    return 'image/png'; // BMP / GIF 输出 PNG
  }
  const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

  function resizeCanvas(canvas, maxEdge) {
    if (!maxEdge) return canvas;
    const long = Math.max(canvas.width, canvas.height);
    if (long <= maxEdge) return canvas;
    const s = maxEdge / long;
    const out = document.createElement('canvas');
    out.width = Math.round(canvas.width * s);
    out.height = Math.round(canvas.height * s);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((res, rej) => {
      canvas.toBlob(b => b ? res(b) : rej(new Error('编码失败')), mime, quality);
    });
  }
  // 让进度条与状态文本有机会刷新；不依赖 requestAnimationFrame（标签页不可见时会冻结）
  const nextFrame = () => new Promise(r => setTimeout(r, 0));

  async function runExport(list, asZip) {
    if (state.exporting || !list.length) return;
    state.exporting = true;
    state.cancelExport = false;
    el.progressOverlay.hidden = false;
    setProgress(0, '准备中…');

    const quality = +$('#expQuality').value / 100;
    const maxEdge = +$('#expResize').value;
    const keepExif = $('#expExif').checked;
    const prefix = $('#expPrefix').value.trim();
    const zip = asZip ? WM.zip.create() : null;
    let done = 0, okCount = 0;

    try {
      for (const img of list) {
        if (state.cancelExport) break;
        setProgress(done / list.length, `处理 ${done + 1} / ${list.length}：${img.name}`);
        await nextFrame();

        // 视频：实时录制导出（格式/尺寸/质量选项不适用）
        if (img.kind === 'video') {
          const vblob = await WM.video.exportRealtime(img, () => state.config, {
            onProgress: (cur, dur) => setProgress(done / list.length,
              `录制 ${img.name} ${cur.toFixed(0)}s / ${dur ? dur.toFixed(0) : '?'}s（实时）`),
            isCancelled: () => state.cancelExport,
            rev: () => state.configRev,
            onWarn: m => U.toast(m, true),
          });
          if (!vblob) break; // 已取消
          const vbase = img.name.replace(/\.[^.]+$/, '') || ('video_' + done);
          const vname = prefix + vbase + WM.video.extFor(vblob.type);
          if (asZip) zip.add(vname, new Uint8Array(await vblob.arrayBuffer()));
          else U.downloadBlob(vblob, vname);
          okCount++;
          done++;
          setProgress(done / list.length, `已处理 ${done} / ${list.length}`);
          continue;
        }

        const rendered = R.render(img, state.config);
        const sized = resizeCanvas(rendered, maxEdge);
        const mime = resolveMime(img);
        let blob = await canvasToBlob(sized, mime, quality);

        // 保留拍摄信息：把原 EXIF 段插回输出 JPEG（方向已转正为 1）
        if (keepExif && mime === 'image/jpeg' && img.exif?.exifSegment) {
          const seg = WM.exif.buildKeepExifSegment(img.exif.exifSegment);
          blob = await WM.exif.insertExifIntoJpeg(blob, seg);
        }

        const base = img.name.replace(/\.[^.]+$/, '') || ('image_' + done);
        const fname = prefix + base + EXT[mime];
        if (asZip) {
          zip.add(fname, new Uint8Array(await blob.arrayBuffer()));
        } else {
          U.downloadBlob(blob, fname);
        }
        okCount++;
        done++;
        setProgress(done / list.length, `已处理 ${done} / ${list.length}`);
      }

      if (asZip && okCount > 0 && !state.cancelExport) {
        setProgress(1, '正在打包 ZIP…');
        await nextFrame();
        U.downloadBlob(zip.generate(), '水印图片.zip');
      }
      setStatus(state.cancelExport
        ? `导出已取消（完成 ${okCount} 张）`
        : `导出完成：${okCount} 张${asZip ? '（ZIP）' : ''}`);
      U.toast(state.cancelExport ? '已取消导出' : `已导出 ${okCount} 张图片`);
    } catch (err) {
      console.error(err);
      U.toast('导出出错：' + err.message, true);
      setStatus('导出失败');
    } finally {
      state.exporting = false;
      el.progressOverlay.hidden = true;
    }
  }

  function setProgress(ratio, text) {
    el.progressBar.style.width = Math.round(ratio * 100) + '%';
    el.progressText.textContent = text;
  }
})();

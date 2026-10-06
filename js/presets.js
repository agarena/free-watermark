/* ══════════════════════════════════════════════
   presets.js — 字体表 / 默认配置 / 8 个样式预设
   预设来自社区流行样式调研：
   斜铺防盗、满铺网格、右下签名、机型参数条、
   头像方章、随机散布、极简角标、抗擦除强化
   ══════════════════════════════════════════════ */
WM.presets = (function () {
  'use strict';

  /* ── 系统字体栈（无需联网加载） ── */
  const FONTS = [
    { id: 'sans',     label: '现代黑体',   value: '-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif' },
    { id: 'kai',      label: '楷体 · 手写感', value: '"Kaiti SC","STKaiti","KaiTi","DFKai-SB","BiauKai",serif' },
    { id: 'song',     label: '宋体 · 印刷感', value: '"Songti SC","SimSun","NSimSun",serif' },
    { id: 'fangsong', label: '仿宋',       value: '"FangSong","STFangsong","FangSong_GB2312",serif' },
    { id: 'yahei',    label: '雅黑',       value: '"Microsoft YaHei","PingFang SC","Heiti SC",sans-serif' },
    { id: 'arial',    label: 'Arial',      value: 'Arial,Helvetica,sans-serif' },
    { id: 'georgia',  label: 'Georgia 衬线', value: 'Georgia,"Times New Roman",serif' },
    { id: 'impact',   label: 'Impact 标题', value: 'Impact,"Arial Black",sans-serif' },
    { id: 'times',    label: 'Times New Roman', value: '"Times New Roman",Times,serif' },
    { id: 'mono',     label: '等宽 Courier', value: '"Courier New",Courier,monospace' },
  ];
  const font = id => (FONTS.find(f => f.id === id) || FONTS[0]).value;

  /* ── 默认配置（与界面初始状态一致） ── */
  function defaultConfig() {
    return {
      text: {
        enabled: true,
        content: '@ 我的名字',
        fontStack: font('sans'),
        sizePct: 5,
        color: '#ffffff',
        autoColor: false,
        weight: 600,
        italic: false,
        stroke: { enabled: true, color: '#000000', width: 1.5 },
        shadow: { enabled: false, color: '#000000', blur: 8 },
        bg: { enabled: false, color: '#000000', opacity: 40 },
      },
      image: {
        enabled: false,
        bitmap: null,        // 离屏 canvas，用户上传
        scalePct: 12,
        shape: 'none',       // none | rounded | circle
        margin: 14,
      },
      layout: {
        mode: 'tile',        // single | tile | random | bar
        opacity: 22,
        anchor: 8,           // 九宫格 0~8，8=右下
        offX: 0, offY: 0,    // 拖拽偏移（%）
        rotate: 0,
        marginPct: 2.5,
        tileAngle: -30,
        gapX: 1.4, gapY: 2.2,
        stagger: false,
        randCount: 14,
        randJitter: 40,
        avoidCenter: true,
      },
      bar: {
        brand: '', model: '', params: '', date: '',
        useLogo: true,
        heightPct: 6.5,
        opacity: 55,
      },
      video: {
        mode: 'fixed',       // fixed 固定 | float 漂浮 | hop 跳位
        amp: 35,             // 漂移幅度（占可用空间 %）
        speed: 1,            // 漂移速度（倍）
        hopInterval: 6,      // 跳位平均间隔（秒）
        hopSmooth: true,     // 换位平滑过渡
      },
    };
  }

  /* ── 深合并（preset 片段覆盖默认值；bitmap 等非纯对象引用直通） ── */
  function isPlain(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function merge(base, patch) {
    if (!isPlain(patch)) return patch;
    const out = isPlain(base) ? { ...base } : {};
    for (const k of Object.keys(patch)) {
      out[k] = merge(out[k], patch[k]);
    }
    return out;
  }

  /* ══════════ 八个预设 ══════════ */
  const PRESETS = [
    {
      id: 'tile-diagonal', name: '斜铺防盗', demo: 'd-tile-diagonal',
      desc: '30° 斜排铺满全图，防盗图最常用',
      config: {
        text: { enabled: true, content: '@ 我的名字', fontStack: font('sans'), sizePct: 5, weight: 600, autoColor: false,
                stroke: { enabled: true, width: 1.5 }, shadow: { enabled: false }, bg: { enabled: false } },
        image: { enabled: false },
        layout: { mode: 'tile', opacity: 22, tileAngle: -30, gapX: 1.4, gapY: 2.2, stagger: false },
      },
    },
    {
      id: 'tile-grid', name: '满铺网格', demo: 'd-tile-grid',
      desc: '更高密度更低透明度，防盗最强',
      config: {
        text: { enabled: true, content: '@ 我的名字', sizePct: 3.2, weight: 600, autoColor: false,
                stroke: { enabled: true, width: 1 }, shadow: { enabled: false }, bg: { enabled: false } },
        image: { enabled: false },
        layout: { mode: 'tile', opacity: 13, tileAngle: 0, gapX: 0.9, gapY: 1.5, stagger: false },
      },
    },
    {
      id: 'signature', name: '右下签名', demo: 'd-signature',
      desc: '手写体签名 + 账号，摄影博主风',
      config: {
        text: { enabled: true, content: '我的名字\n@ 我的账号 · x.com/name', fontStack: font('kai'),
                sizePct: 3.4, weight: 400, color: '#ffffff', autoColor: false,
                stroke: { enabled: false }, shadow: { enabled: true, blur: 10 }, bg: { enabled: false } },
        image: { enabled: false },
        layout: { mode: 'single', opacity: 72, anchor: 8, offX: 0, offY: 0, rotate: 0 },
      },
    },
    {
      id: 'photo-bar', name: '机型参数条', demo: 'd-bar',
      desc: '底部厂商/机型/参数条，晒图标配',
      config: {
        text: { enabled: true },
        image: { enabled: false },
        layout: { mode: 'bar' },
        bar: { heightPct: 6.5, opacity: 55, useLogo: true },
      },
    },
    {
      id: 'avatar-stamp', name: '头像方章', demo: 'd-stamp',
      desc: '圆头像 + ID 章印，防冒充防盗用',
      config: {
        text: { enabled: true, content: '我的名字\nID: 12345678', fontStack: font('sans'), sizePct: 2.6,
                weight: 600, color: '#ffffff', autoColor: false,
                stroke: { enabled: true, width: 1 }, shadow: { enabled: false }, bg: { enabled: false } },
        image: { enabled: true, scalePct: 9, shape: 'circle', margin: 16 },
        layout: { mode: 'single', opacity: 88, anchor: 8, offX: 0, offY: 0, rotate: 0 },
      },
    },
    {
      id: 'random-scatter', name: '随机散布', demo: 'd-random',
      desc: '四因子随机打散，算法更难去除',
      config: {
        text: { enabled: true, content: '@ 我的名字', sizePct: 4.2, weight: 600, autoColor: false,
                stroke: { enabled: true, width: 1.2 }, shadow: { enabled: false }, bg: { enabled: false } },
        image: { enabled: false },
        layout: { mode: 'random', opacity: 26, randCount: 14, randJitter: 40, avoidCenter: true, rotate: -15 },
      },
    },
    {
      id: 'minimal-corner', name: '极简角标', demo: 'd-corner',
      desc: '© + 署名小字，克制不抢画面',
      config: {
        text: { enabled: true, content: '© 我的名字', sizePct: 2.4, weight: 400, color: '#ffffff',
                autoColor: true, stroke: { enabled: true, width: 0.8 }, shadow: { enabled: false }, bg: { enabled: false } },
        image: { enabled: false },
        layout: { mode: 'single', opacity: 66, anchor: 8, offX: 0, offY: 0, rotate: 0 },
      },
    },
    {
      id: 'anti-erase', name: '抗擦除强化', demo: 'd-noise',
      desc: '高密度粗描边，提高 AI 擦除成本',
      config: {
        text: { enabled: true, content: '@ 我的名字 请勿盗图', sizePct: 5.5, weight: 900, autoColor: false,
                stroke: { enabled: true, width: 2.6 }, shadow: { enabled: false }, bg: { enabled: false } },
        image: { enabled: false },
        layout: { mode: 'tile', opacity: 30, tileAngle: -30, gapX: 0.8, gapY: 1.3, stagger: true },
      },
    },
  ];

  /* 应用样式预设：默认配置 + 片段合并。
     内容字段（文字内容、图片位图与开关）保留用户当前值——样式只管外观，不动内容 */
  function apply(preset, current) {
    const cfg = merge(defaultConfig(), preset.config);
    if (current) {
      cfg.text.content = current.text.content;
      cfg.image.bitmap = current.image.bitmap;
      cfg.image.enabled = current.image.enabled;
    }
    return cfg;
  }

  return { FONTS, font, defaultConfig, merge, PRESETS, apply };
})();

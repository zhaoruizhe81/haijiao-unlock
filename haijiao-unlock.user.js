// ==UserScript==
// @name         海角社区 · 付费视频解锁(CDN完整播放列表) + 去广告
// @namespace    local.haijiao.unlock
// @version      1.0.2
// @description  用 CDN 上同目录的完整 m3u8 替换试看 m3u8（API 只下发 30 秒试看列表，完整列表未鉴权）；顺手清掉广告位。不改 cookie、不改 DOM 付费状态、不发任何第三方请求。
// @author       local
// @match        https://haijiao.com/*
// @match        https://www.haijiao.com/*
// @match        https://haijiao2023.com/*
// @match        https://www.haijiao2023.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理（实测于 pid=471433 / pid=603252）：
 *   1. /api/topic/<pid> 返回体是三重 base64，解出来的 attachments[].remoteUrl 只给
 *      "xxxx_i_preview.m3u8"（试看列表，30 秒 / 17 段）。
 *   2. 该列表里的分片名带出流 ID：2914240GjGiFvxI_i0.ts → 流 = 2914240GjGiFvxI。
 *   3. 同目录下 <流ID>_i.m3u8 就是完整列表（132 段 / 131.7s；pid=603252 是 233 段 / 252s），
 *      同一把 AES-128 key（enc_<流号>.key）与同一个 IV —— 也就是说 CDN 并不知道"付没付费"。
 *   4. 播放器侧只做两件事：把 loadSource 的 URL 换成完整列表；密钥混淆文件 <列表>.jpg
 *      若不存在则回落到试看那份（同一条流，密钥材料相同）。
 *
 * 脚本不碰：
 *   - 不修改 is_buy / sale 等任何接口返回，不伪造购买状态；
 *   - 不上传/回传任何数据，只用页面自己的 fetch/hls.js；
 *   - 不绕过 AES 加密本身，解密仍由站点自己的 wasm jquery_key 流程完成。
 */

(function () {
  'use strict';

  const CFG = {
    unlock: true,            // 解锁完整播放列表
    preferPreviewKeyBlob: true, // 密钥混淆文件优先用试看那份（同流同key，最稳）
    hideAds: true,           // 隐藏广告位
    killNotices: true,       // 关掉站点的"落地页弹窗"（防劫持/18+/收藏域名 三个公告）
    blockAdRequests: false,  // 直接掐掉 banner_list 请求（更干净，但某些皮肤会留空盒子）
    showButtons: true,       // 显示"完整版已接管"角标 + 复制链接 / 本页播放按钮
    debug: true,
    maxSegments: 0           // >0 只保留前 N 段（调试用）
  };

  const LOG = (...a) => CFG.debug && console.log('%c[海角解锁]', 'color:#e91e63;font-weight:bold', ...a);
  const WARN = (...a) => console.warn('[海角解锁]', ...a);

  /* ------------------------------------------------------------------ 工具 */

  // 试看列表 → 流 ID
  function streamIdFromPlaylist(text) {
    if (typeof text !== 'string') return null;
    const m = text.match(/^\s*([A-Za-z0-9_-]+)_i\d+\.ts\s*$/m);
    return m ? m[1] : null;
  }

  function playlistUrlToBase(url) {
    return url.replace(/[^/]*$/, '');
  }

  async function head(url) {
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
      if (!r.ok) return null;
      const len = Number(r.headers.get('content-length') || 0);
      return { url, len };
    } catch (e) { return null; }
  }

  async function resolveFullPlaylist(previewUrl, pageFetch) {
    const f = pageFetch || fetch;
    let text;
    try {
      const r = await f(previewUrl, { cache: 'no-store' });
      if (!r.ok) return null;
      text = await r.text();
    } catch (e) { WARN('拉试看列表失败', e); return null; }

    const stream = streamIdFromPlaylist(text);
    if (!stream) {
      // 新版格式（2026 起）：分片名是 32 位随机 hex，无公共前缀 → 完整列表不可推导
      const randomSegs = /^\s*[0-9a-f]{32}\.ts\s*$/m.test(text);
      WARN(randomSegs ? '新格式帖子：分片名随机，CDN 上无可推导的完整列表' : '试看列表里没解析出流 ID');
      return { unsupported: randomSegs ? 'random-segments' : 'no-stream-id', previewUrl };
    }

    const base = playlistUrlToBase(previewUrl);
    for (const name of [`${stream}_i.m3u8`, `${stream}.m3u8`, `${stream}_full.m3u8`]) {
      const hit = await head(base + name);
      if (hit) {
        LOG('完整播放列表命中:', hit.url, hit.len ? `(${hit.len} B)` : '');
        return { url: hit.url, stream, previewUrl };
      }
    }
    WARN('没找到完整播放列表，回落试看:', stream);
    return null;
  }

  /* ------------------------------------------- 密钥混淆文件 <列表>.jpg 重定向 */

  // full.m3u8 → full.jpg；若该 jpg 不可用则改用试看那份 jpg
  const blobRemap = new Map();

  async function decideBlob(fullUrl, previewUrl) {
    const fullJpg = fullUrl.replace(/\.m3u8.*$/, '.jpg');
    const pvJpg = previewUrl.replace(/\.m3u8.*$/, '.jpg');
    if (fullJpg === pvJpg) return;
    if (CFG.preferPreviewKeyBlob) { blobRemap.set(fullJpg, pvJpg); LOG('密钥文件用试看版:', pvJpg); return; }
    const probe = await head(fullJpg);
    if (probe && probe.len > 0) { LOG('密钥文件用完整版:', fullJpg); return; }
    blobRemap.set(fullJpg, pvJpg);
    LOG('完整版密钥文件不可用，回落试看版:', pvJpg);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url && blobRemap.has(url)) {
      LOG('重定向密钥文件:', url, '→', blobRemap.get(url));
      url = blobRemap.get(url);
      return nativeFetch.call(this, url, init);
    }
    return nativeFetch.apply(this, arguments);
  };

  // 站点还可能用 XHR 拉密钥文件，一并兜住
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string' && blobRemap.has(url)) {
      LOG('XHR 重定向密钥文件:', url, '→', blobRemap.get(url));
      url = blobRemap.get(url);
    }
    return nativeOpen.apply(this, [method, url].concat([].slice.call(arguments, 2)));
  };

  /* ------------------------------------------------------ hls.js loadSource 接管 */

  const resolved = new Map();   // previewUrl → 派生结果（含未命中）
  const busy = new Set();
  const handledPreviews = new Set();   // 已接管的试看地址（字符串不可挂属性）
  let hooked = false;

  function isPreview(u) { return typeof u === 'string' && /_preview\.m3u8(\?|$)/.test(u); }

  async function ensureDerived(previewUrl) {
    if (resolved.has(previewUrl)) return resolved.get(previewUrl);
    if (busy.has(previewUrl)) return null;
    busy.add(previewUrl);
    const hit = await resolveFullPlaylist(previewUrl);
    if (hit && hit.url) await decideBlob(hit.url, previewUrl);
    resolved.set(previewUrl, hit);
    busy.delete(previewUrl);
    return hit;
  }

  function hookHls() {
    const Hls = window.Hls;
    if (!Hls || !Hls.prototype || hooked) return !!Hls;
    const orig = Hls.prototype.loadSource;
    if (typeof orig !== 'function') return false;

    Hls.prototype.loadSource = function (url) {
      const self = this;
      if (CFG.unlock && isPreview(url) && !handledPreviews.has(url)) {
        handledPreviews.add(url);
        LOG('拦到试看播放列表:', url);
        ensureDerived(url).then((hit) => {
          const target = (hit && hit.url) || url;
          if (hit && hit.url) badge(`完整版已接管 · ${hit.stream}`);
          else if (hit && hit.unsupported === 'random-segments') badge('新格式帖子：分片名随机，CDN 上无可推导的完整列表\n（本页播放官方试看）');
          else badge('未找到完整版，播放试看');
          try { orig.call(self, target); } catch (e) { WARN('loadSource 失败，回落试看', e); orig.call(self, url); }
        }).catch(() => { orig.call(self, url); });
        return self;
      }
      return orig.apply(this, arguments);
    };

    hooked = true;
    LOG('hls.js 已接管');
    return true;
  }

  // hls.min.js 是异步注入的，轮询等它出现
  let tries = 0;
  const timer = setInterval(() => {
    if (hookHls() || ++tries > 600) clearInterval(timer);   // 最多等 60s
  }, 100);

  /* ------------------------------------------- 原生 <video src> 兜底（iOS 路径） */

  const handledNative = new WeakSet();
  setInterval(() => {
    if (!CFG.unlock) return;
    document.querySelectorAll('video').forEach((v) => {
      const s = v.getAttribute('src') || v.src || '';
      if (isPreview(s) && !handledNative.has(v)) {
        handledNative.add(v);
        ensureDerived(s).then((hit) => {
          if (!hit) return;
          LOG('原生 video.src 换成完整版:', hit.url);
          v.src = hit.url; v.load();
          if (v.play) v.play().catch(() => {});
        });
      }
    });
  }, 2000);

  /* ------------------------------------------------------------- 广告位清理 */

  const AD_CSS = `
    .containeradvertising,
    .containeradvertising.hasfixed,
    .containeradvertising.haslist,
    .containeradvertising.nopadding,
    [class*="containeradvertising"],
    .shutdown { display: none !important; }
  `;

  function killAds() {
    if (!CFG.hideAds) return;
    document.querySelectorAll('[class*="containeradvertising"]').forEach((el) => el.remove());
  }

  function setupAds() {
    if (!CFG.hideAds) return;
    const style = document.createElement('style');
    style.textContent = AD_CSS;
    (document.head || document.documentElement).appendChild(style);
    killAds();
    new MutationObserver(killAds).observe(document.documentElement, { childList: true, subtree: true });
    LOG('广告位清理已启用');
  }

  /* -------------------------------------- 落地页弹窗清理（站点自己的公告弹窗） */

  // 进站/定时弹的三种 Element-UI 弹窗：防劫持提示、"请确保年满18周岁"、"请收藏5个以上域名"。
  // 特点：class 带 luodiye_*，外面套 .el-dialog__wrapper，旁边还有 .v-modal 遮罩。
  //
  // ⚠️ 这里踩过一个坑：.v-modal 是 Element-UI **全局唯一**的共享遮罩（由 PopupManager
  // 的模态栈管理，整个页面只会有一个）。我们用 DOM remove() 干掉了公告弹窗的 wrapper，
  // PopupManager 的栈并不会出栈 —— 遮罩就永久留在页面上：半透明黑铺满视口、
  // pointer-events:auto，整页点不动、滚不了。
  //
  // 所以判断依据**不能**是"还剩几个 wrapper"：站内自己就常驻两个 display:none 的
  // wrapper（my-dialog / announcement-dialog），那个条件永远为 false。
  // 唯一可靠的判据是 **有没有"真正可见"的弹窗**。
  const NOTICE_CSS = `
    [class*="luodiye"] { display: none !important; }
  `;

  /** 是否存在真正渲染出来的 Element-UI 弹窗（display:none 的常驻 wrapper 不算）。 */
  function hasLiveDialog() {
    return Array.from(document.querySelectorAll('.el-dialog__wrapper')).some((w) => {
      if (getComputedStyle(w).display === 'none') return false;
      const dlg = w.querySelector('.el-dialog');
      if (!dlg) return false;
      const cs = getComputedStyle(dlg);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = dlg.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  /** 站点的滚动锁：Element-UI 会给 body 加 el-popup-parent--hidden { overflow: hidden }。 */
  function unlockScroll() {
    let changed = false;
    for (const el of [document.body, document.documentElement]) {
      if (el.classList.contains('el-popup-parent--hidden')) {
        el.classList.remove('el-popup-parent--hidden');
        changed = true;
      }
    }
    if (document.body.style.overflow === 'hidden') { document.body.style.overflow = ''; changed = true; }
    if (document.body.style.paddingRight) { document.body.style.paddingRight = ''; changed = true; }
    return changed;
  }

  // 孤儿遮罩的确认计时：真弹窗进场动画的头几帧 rect 还是 0，
  // 立即摘会误杀它的背景。等 250ms 再确认一次，由 1.5s 巡检兜底重试。
  let maskSeenAt = 0;

  /**
   * 摘掉孤儿遮罩 + 解锁滚动。
   * 错杀一个真弹窗的遮罩只是少层暗背景；漏杀却是整页瘫掉 —— 所以只要确认
   * 没有可见弹窗就动手，但先等一拍排除进场动画。
   */
  function dropOrphanMask() {
    if (hasLiveDialog()) { maskSeenAt = 0; return false; }
    const now = Date.now();
    if (maskSeenAt === 0) { maskSeenAt = now; return false; }
    if (now - maskSeenAt < 250) return false;
    maskSeenAt = 0;
    let dropped = false;
    document.querySelectorAll('.v-modal').forEach((m) => { m.remove(); dropped = true; });
    if (unlockScroll()) dropped = true;
    return dropped;
  }

  function killNotices() {
    if (!CFG.killNotices) return;
    let killed = 0;
    document.querySelectorAll('.el-dialog[class*="luodiye"], .el-dialog__wrapper [class*="luodiye"]').forEach((dlg) => {
      const wrapper = dlg.closest('.el-dialog__wrapper');
      (wrapper || dlg).remove();
      killed++;
    });
    const dropped = dropOrphanMask();
    if (killed) LOG('清掉落地页弹窗:', killed);
    if (dropped) LOG('摘掉孤儿遮罩 + 解锁滚动');
  }

  let noticeBusy = false;
  function tickNotices() {
    if (noticeBusy) return;
    noticeBusy = true;
    try { killNotices(); } finally { noticeBusy = false; }
  }

  function setupNotices() {
    if (!CFG.killNotices) return;
    const style = document.createElement('style');
    style.textContent = NOTICE_CSS;
    (document.head || document.documentElement).appendChild(style);
    killNotices();
    new MutationObserver(tickNotices).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
    });
    // 巡检兜底：站点随时可能重新挂上遮罩，而没有任何 DOM 变动可监听时
    // MutationObserver 不会触发 —— 页面会再次瘫掉却没有事件唤醒我们。
    setInterval(() => { if (!document.hidden) tickNotices(); }, 1500);
    LOG('落地页弹窗清理已启用');
  }

  if (CFG.blockAdRequests) {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/api\/banner\/banner_list/.test(url)) return Promise.resolve(new Response('{}', { status: 200 }));
      return of.apply(this, arguments);
    };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      if (typeof u === 'string' && /\/api\/banner\/banner_list/.test(u)) {
        this.__hjBlock = true;
        return oo.call(this, m, 'data:application/json,{}');
      }
      return oo.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------ 页面角标/按钮 */

  let badgeEl = null;
  function badge(text) {
    if (!CFG.showButtons) return;
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;background:#111;color:#0f0;'
        + 'font:12px/1.5 -apple-system,"PingFang SC",monospace;padding:6px 10px;border-radius:6px;opacity:.85;'
        + 'max-width:340px;white-space:pre-wrap;';
      (document.body || document.documentElement).appendChild(badgeEl);
    }
    badgeEl.textContent = text;
  }

  // 页面数据里直接拿试看地址，做成"一键复制完整链接"的浮标
  function floatingActions() {
    if (!CFG.showButtons || document.getElementById('hj-unlock-fab')) return;
    const box = document.createElement('div');
    box.id = 'hj-unlock-fab';
    box.style.cssText = 'position:fixed;right:14px;top:120px;z-index:2147483646;display:flex;flex-direction:column;gap:6px;';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:#e91e63;color:#fff;border:0;border-radius:6px;padding:6px 10px;font:12px -apple-system,"PingFang SC";cursor:pointer;opacity:.9;';
      b.onclick = fn;
      return b;
    };
    box.append(
      mk('复制完整 m3u8', async () => {
        const list = await collectPreviewUrls();
        if (!list.length) return alert('没找到试看列表地址');
        const hit = await resolveFullPlaylist(list[0]);
        if (!hit || !hit.url) return alert(hit && hit.unsupported === 'random-segments'
          ? '这是新格式帖子：分片名随机，CDN 上无可推导的完整列表（43 分钟那条就属于这种）'
          : '没找到完整列表');
        await navigator.clipboard.writeText(hit.url);
        badge('已复制:\n' + hit.url);
      }),
      mk('本页播完整版', async () => {
        const list = await collectPreviewUrls();
        if (!list.length) return alert('没找到试看列表地址');
        const hit = await resolveFullPlaylist(list[0]);
        if (!hit || !hit.url) return alert(hit && hit.unsupported === 'random-segments'
          ? '这是新格式帖子：分片名随机，CDN 上无可推导的完整列表（43 分钟那条就属于这种）'
          : '没找到完整列表');
        playFullHere(hit.url);
      })
    );
    (document.body || document.documentElement).appendChild(box);
  }

  // 从页面里捞试看 m3u8 地址：network 抓不到历史，就从 Vue 实例 + DOM 属性里翻
  async function collectPreviewUrls() {
    const urls = new Set();
    // 0) 站点把试看地址写在容器属性上：.video-div[data-url]
    document.querySelectorAll('[data-url*="_preview.m3u8"],[data-url*="_preview.m3u8"]').forEach((el) => {
      const u = el.getAttribute('data-url');
      if (u) urls.add(u);
    });
    // 1) 从已加载的 hls 实例里翻
    document.querySelectorAll('video').forEach((v) => {
      try {
        const src = (v.__hls && v.__hls.url) || v.currentSrc || v.src;
        if (src && isPreview(src)) urls.add(src);
      } catch (e) {}
    });
    // 2) 从 DOM 里正则扫
    const html = document.documentElement.outerHTML;
    (html.match(/https?:\/\/[^"'\s<>]+_preview\.m3u8[^"'\s<>]*/g) || []).forEach((u) => urls.add(u));
    // 3) 走 API（三重 base64）
    const pid = new URLSearchParams(location.search).get('pid');
    if (pid) {
      try {
        const j = await (await fetch(`/api/topic/${pid}`, { cache: 'no-store' })).json();
        if (j && j.data) {
          let d = j.data;
          for (let i = 0; i < 4 && typeof d === 'string'; i++) {
            try { d = decodeURIComponent(escape(atob(d))); } catch (e) { break; }
            try { const o = JSON.parse(d); d = o; break; } catch (e) {}
          }
          (d.attachments || []).forEach((a) => { if (isPreview(a.remoteUrl)) urls.add(a.remoteUrl); });
        }
      } catch (e) {}
    }
    return [...urls];
  }

  // 用站点自己的 hls.js + 自己的 wasm 密钥流程起一个独立播放器
  async function playFullHere(fullUrl) {
    const Hls = window.Hls;
    if (!Hls) return alert('hls.js 还没加载完，稍后再试');
    const dlg = document.createElement('div');
    dlg.style.cssText = 'position:fixed;inset:5% 10%;z-index:2147483647;background:#000;border:2px solid #e91e63;border-radius:10px;overflow:hidden;';
    const close = document.createElement('button');
    close.textContent = '关闭';
    close.style.cssText = 'position:absolute;right:8px;top:8px;z-index:2;background:#e91e63;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;';
    const v = document.createElement('video');
    v.controls = true; v.autoplay = true; v.playsInline = true;
    v.style.cssText = 'width:100%;height:100%;background:#000;';
    dlg.append(v, close);
    document.body.appendChild(dlg);
    close.onclick = () => { try { hls.destroy(); } catch (e) {} dlg.remove(); };

    // 复刻站点的密钥处理：.key → .keyv<kversion>，再经 wasm jquery_key 与 <列表>.jpg 变换
    let wasm = null, jpgBytes = null, keyCache = null;
    const jpgUrl = fullUrl.replace(/\.m3u8.*$/, '.jpg');
    const previewJpg = blobRemap.get(jpgUrl);
    try {
      const b = await (await fetch(previewJpg || jpgUrl, { cache: 'no-store' })).text();
      const raw = atob(b.trim());
      jpgBytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    } catch (e) { WARN('密钥混淆文件拉取失败', e); }
    if (typeof window.createModule === 'function') {
      try { wasm = await window.createModule(); } catch (e) { WARN('wasm 初始化失败', e); }
    }

    const hls = new Hls({
      debug: false, autoStartLoad: false, maxBufferLength: 15, maxMaxBufferLength: 30, maxBufferSize: 3e7, startLevel: -1,
      xhrSetup(xhr, url) {
        const kv = (() => { try { return JSON.parse(sessionStorage.getItem('config') || '{}').kversion || ''; } catch (e) { return ''; } })();
        if (url.includes('.key')) xhr.open('GET', url.replace('.key', '.keyv' + kv), true);
      }
    });

    hls.on(Hls.Events.KEY_LOADED, (e, data) => {
      try {
        if (!jpgBytes || !wasm) return;
        if (keyCache) { data.frag.decryptdata.key = keyCache; return; }
        const k = new Uint8Array(data.frag.decryptdata.key);
        const pk = wasm._malloc(k.length), pj = wasm._malloc(jpgBytes.length);
        wasm.HEAPU8.set(k, pk); wasm.HEAPU8.set(jpgBytes, pj);
        wasm.ccall('jquery_key', null, ['number', 'number', 'number', 'number'], [pk, k.length, pj, jpgBytes.length]);
        keyCache = new Uint8Array(wasm.HEAPU8.buffer, pk, k.length).slice();
        wasm._free(pk); wasm._free(pj);
        data.frag.decryptdata.key = keyCache;
      } catch (err) { WARN('密钥变换失败', err); }
    });
    hls.on(Hls.Events.ERROR, (e, d) => WARN('HLS', d.type, d.details, d.reason || ''));
    hls.attachMedia(v);
    hls.loadSource(fullUrl);
    hls.startLoad();
    badge('独立播放器已启动');
  }

  /* ---------------------------------------------------------------- 启动流程 */

  function boot() {
    setupAds();
    setupNotices();
    hookHls();
    floatingActions();
    LOG('已加载 · 油猴脚本 v1.0.1');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

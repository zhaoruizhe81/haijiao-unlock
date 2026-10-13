// ==UserScript==
// @name         海角社区 · 付费视频解锁(CDN完整播放列表) + 去广告
// @namespace    local.haijiao.unlock
// @version      1.3.0
// @description  用 CDN 上同目录的完整 m3u8 替换试看 m3u8（API 只下发 30 秒试看列表，完整列表未鉴权）；一键下载并解密成 TS，另给一条 ffmpeg 命令转成真 MP4；顺手清掉广告位。不改 cookie、不改 DOM 付费状态、零第三方依赖。
// @author       zhaoruizhe81
// @homepageURL  https://github.com/zhaoruizhe81/haijiao-unlock
// @supportURL   https://github.com/zhaoruizhe81/haijiao-unlock/issues
// @downloadURL  https://raw.githubusercontent.com/zhaoruizhe81/haijiao-unlock/main/haijiao-unlock.user.js
// @updateURL    https://raw.githubusercontent.com/zhaoruizhe81/haijiao-unlock/main/haijiao-unlock.user.js
// @license      MIT
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
    download: true,          // 显示"下载视频"按钮
    downloadConcurrency: 6,  // 下载并发分片数（有序落盘，内存占用与视频长度无关）
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
    if (CFG.download) {
      box.append(mk('⬇ 下载视频 (TS)', () => downloadVideo()));
      box.append(mk('复制 ffmpeg 转 MP4 命令', copyMp4Command));
    }
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

  /* ---------------------------------------------------------------- 视频下载 */

  /*
   * 下载链路（实测通过：解的明文连续 4 个 0x47，即 MPEG-TS 的 188 字节同步字）：
   *
   *   播放列表 → 分片列表 + #EXT-X-KEY(METHOD=AES-128, URI=enc_<流>.key, IV=0x…)
   *      ↓
   *   密钥不是直给的：站点把 16 字节原始密钥再经自己的 wasm 过一遍 ——
   *   jquery_key(keyBytes, <列表>.jpg 的字节)，输出的才是真 AES key。
   *      ↓
   *   每个分片 = AES-128-CBC + PKCS#7，用 WebCrypto 解（它自带去填充，明文正好短 4 字节）
   *      ↓
   *   并发抓、**按序落盘** → 内存占用只跟并发数有关，跟视频多长无关
   *
   * 两个刻意的设计：
   *   1. 拿完密钥先拿"首段能不能解出 0x47"验证一遍，验不过就换下一个混淆文件、
   *      全验不过就直接报错 —— 宁可不下载，也不产出一个看着像视频的坏文件。
   *   2. 一开始就要文件句柄。showSaveFilePicker 需要"用户手势"，而任何 await
   *      之后手势就过期了，所以必须放在最前面问。
   */

  /** 把播放列表文本解析成下载所需的一切。只认本站实际用到的标签子集。 */
  function parsePlaylist(text, playlistUrl) {
    const out = {
      segments: [], key: null, map: null, duration: 0,
      mediaSequence: 0, hasByteRange: false,
    };
    let pendingDuration = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        out.mediaSequence = Number.parseInt(line.slice(21), 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const method = /METHOD=([^,]+)/.exec(line);
        const uri = /URI="([^"]+)"/.exec(line);
        const iv = /IV=0x([0-9a-fA-F]+)/.exec(line);
        out.key = method && method[1] !== 'NONE'
          ? { method: method[1], url: uri ? new URL(uri[1], playlistUrl).href : null, iv: iv ? iv[1] : null }
          : null;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const uri = /URI="([^"]+)"/.exec(line);
        if (uri) out.map = new URL(uri[1], playlistUrl).href;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        out.hasByteRange = true;
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = Number.parseFloat(line.slice(8)) || 0;
      } else if (!line.startsWith('#')) {
        out.segments.push({
          url: new URL(line, playlistUrl).href,
          seq: out.mediaSequence + out.segments.length,
        });
        out.duration += pendingDuration;
        pendingDuration = 0;
      }
    }
    return out;
  }

  /** 没有显式 IV 时按 RFC 8216：用分片序号做 16 字节大端 IV。 */
  function ivForSegment(pl, seg) {
    if (pl.key && pl.key.iv) {
      return new Uint8Array((pl.key.iv.match(/../g) || []).map((h) => Number.parseInt(h, 16)));
    }
    const iv = new Uint8Array(16);
    let n = seg.seq >>> 0;
    for (let i = 15; i >= 0 && n > 0; i--) { iv[i] = n & 0xff; n >>>= 8; }
    return iv;
  }

  async function fetchBytes(url) {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(-48)}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  // wasm 模块建一次就够，别每段都重建
  let wasmModule = null;
  async function getWasm() {
    if (!wasmModule) {
      if (typeof window.createModule !== 'function') throw new Error('站点的 wasm 模块未加载');
      wasmModule = await window.createModule();
    }
    return wasmModule;
  }

  /** 复刻站点的密钥变换：jquery_key(keyBytes, 混淆文件字节) 就地改密钥。 */
  async function transformKey(raw, disguise) {
    const wasm = await getWasm();
    const pk = wasm._malloc(raw.length);
    const pj = wasm._malloc(disguise.length);
    try {
      wasm.HEAPU8.set(raw, pk);
      wasm.HEAPU8.set(disguise, pj);
      wasm.ccall('jquery_key', null, ['number', 'number', 'number', 'number'],
        [pk, raw.length, pj, disguise.length]);
      return new Uint8Array(wasm.HEAPU8.buffer, pk, raw.length).slice();
    } finally {
      wasm._free(pk);
      wasm._free(pj);
    }
  }

  /**
   * 解出真正能用的 AES 密钥，并用首段做验证。
   *
   * 混淆文件按顺序试：完整列表自己那份 → 试看那份（同一条母流，密钥材料相同）。
   * 每份都拿首段解一次，明文必须是 188 字节对齐的 MPEG-TS（连续 0x47）。
   * 全部试完还不行就抛错 —— 不返回一个"看起来对"的密钥。
   *
   * 用 nativeFetch 而不是被脚本改写过的 fetch：blobRemap 会把完整版那份
   * 重定向到试看那份，那样两个候选就变成同一个地址，验证就没意义了。
   */
  async function resolveDecryptKey(pl, fullUrl, previewUrl) {
    if (!pl.key || !pl.key.url) return { cryptoKey: null, probe: null };
    if (pl.key.method !== 'AES-128') throw new Error(`暂不支持的加密方式：${pl.key.method}`);

    let kversion = '';
    try { kversion = JSON.parse(sessionStorage.getItem('config') || '{}').kversion || ''; } catch (e) {}
    const rawCandidates = kversion
      ? [pl.key.url.replace('.key', '.keyv' + kversion), pl.key.url]
      : [pl.key.url];
    let raw = null;
    for (const u of rawCandidates) {
      try { raw = await fetchBytes(u); if (raw && raw.length) break; } catch (e) { WARN('密钥获取失败', u.slice(-40), e); }
    }
    if (!raw || raw.length < 16) throw new Error('密钥文件拿不到或长度不足');
    raw = raw.slice(0, 16);

    const seen = new Set();
    const disguiseUrls = [fullUrl, previewUrl]
      .filter(Boolean)
      .map((u) => u.replace(/\.m3u8.*$/, '.jpg'))
      .filter((u) => !seen.has(u) && seen.add(u));

    const probeSeg = pl.segments[0];
    const probeCipher = await fetchBytes(probeSeg.url);

    for (const du of disguiseUrls) {
      let disguise;
      try {
        const txt = await (await nativeFetch.call(window, du, { cache: 'no-store', credentials: 'omit' })).text();
        disguise = Uint8Array.from(atob(txt.trim()), (c) => c.charCodeAt(0));
      } catch (e) { WARN('混淆文件不可用', du.slice(-40)); continue; }

      let real;
      try { real = await transformKey(raw, disguise); } catch (e) { WARN('密钥变换失败', e); continue; }

      const cryptoKey = await crypto.subtle.importKey('raw', real, { name: 'AES-CBC' }, false, ['decrypt']);
      try {
        const plain = new Uint8Array(await crypto.subtle.decrypt(
          { name: 'AES-CBC', iv: ivForSegment(pl, probeSeg) }, cryptoKey, probeCipher));
        if (plain[0] === 0x47 && plain[188] === 0x47) {
          LOG('密钥验证通过 · 混淆文件:', du.split('/').pop());
          return { cryptoKey, probe: { url: probeSeg.url, plain } };
        }
        WARN('该混淆文件解出的密钥解不开首段（同步字不对）:', du.split('/').pop());
      } catch (e) {
        WARN('该混淆文件解出的密钥解密抛错:', du.split('/').pop(), e.message);
      }
    }
    throw new Error('密钥对不上：候选混淆文件都解不出有效的 MPEG-TS 头部');
  }

  function sanitizeName(text, fallback) {
    const t = String(text || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return t || fallback;
  }

  /**
   * 这个元素是不是**真的渲染出来了**。
   *
   * 坑在这：隐藏元素（站点的各种 Element-UI 弹窗）的 textContent 照样能读到，
   * 所以"有文字"完全不能作为"这是页面上的标题"的依据。必须逐级往上确认祖先
   * 都没有 display:none / visibility:hidden，并且自己有非零尺寸。
   */
  function isRendered(el) {
    if (!el || !el.isConnected) return false;
    for (let n = el; n instanceof Element; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  }

  // 站点的 UI 文案。只有翻到隐藏弹窗时才读得到它们，出现即判为误命中。
  const TITLE_REJECT = /(请选择|正在移动|我的置顶|举报|确认|取消|提示|线路|点击购买|出售内容|预览|海角社区|^[\d\s.·-]+$)/;

  /**
   * 同步取一个像标题的东西（要赶在 showSaveFilePicker 之前，不能 await）。
   *
   * 顺序是"越像标题越靠前"：h2 是这个站放正文标题的地方；h1 常常只是个空的
   * 图标容器（textContent 为空，会被下面的长度检查自然跳过）；泛匹配
   * [class*="title"] 放最后兜底，它最容易撞上隐藏弹窗。
   */
  function quickTitle() {
    const sels = ['h2', 'h1', 'h3', '[class*="post-title"]', '[class*="article-title"]',
      '[class*="detail-title"]', '[class*="title"]'];
    const seen = new Set();
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isRendered(el)) continue;
        const t = sanitizeName(el.textContent, '');
        if (t.length < 4 || t.length > 90) continue;
        if (TITLE_REJECT.test(t)) continue;
        return t;
      }
    }
    // 退一步：<title> 去掉站点后缀
    const dt = sanitizeName(document.title, '').replace(/[-|·]\s*海角社区.*$/, '').trim();
    return dt && dt !== '海角社区' && !TITLE_REJECT.test(dt) ? dt : 'haijiao';
  }

  let downloadBusy = false;
  let downloadCancelled = false;

  /** 上一次成功保存的文件名，用来拼 ffmpeg 命令。 */
  let lastSavedName = '';

  /**
   * 复制一条"把已下载的 .ts 转成 mp4"的命令。
   *
   * 为什么不在浏览器里直接产出 mp4：试过 mux.js，它产出的是 **给 MSE 用的分片流**
   * （hls.js 会把视频轨和音频轨分别 append 到两个 SourceBuffer），天生按轨出分片、
   * 不做交织。ffmpeg 能宽容地读它，但 Apple 的 AVFoundation **打不开** —— QuickTime
   * 只会显示一个 27 小时的时长，并且解不出任何一帧。完整记录见 README 第 5.6 节。
   *
   * 而在本地，ffmpeg 流拷贝是 0.04 秒的事：无损、不重编码、体积还更小。所以这一步交给它。
   */
  async function copyMp4Command() {
    const base = (lastSavedName || `${quickTitle()}_完整版.ts`).replace(/\.ts$/i, '');
    const cmd = `ffmpeg -i "${base}.ts" -c copy "${base}.mp4"`;
    try {
      await navigator.clipboard.writeText(cmd);
      badge('已复制（在该文件所在目录执行）:\n' + cmd);
    } catch (e) {
      badge('复制失败，手动复制:\n' + cmd);
    }
  }

  async function downloadVideo() {
    if (downloadBusy) { downloadCancelled = true; badge('正在取消…（当前分片下完就停）'); return; }
    downloadBusy = true;
    downloadCancelled = false;
    let writable = null;

    try {
      // ① 文件句柄必须最先要：showSaveFilePicker 依赖"用户手势"，
      //    任何 await 之后手势就过期了，那时再调会直接抛 NotAllowedError。
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: `${quickTitle()}.ts` });
          writable = await handle.createWritable();
        } catch (e) {
          if (e && e.name === 'AbortError') { badge('已取消'); return; }
          WARN('流式落盘不可用，退回内存模式（大文件可能吃内存）', e);
          writable = null;
        }
      }

      // ② 定位播放列表
      badge('解析播放列表…');
      const lists = await collectPreviewUrls();
      if (!lists.length) { badge('没找到试看列表地址'); return; }
      const previewUrl = lists[0];
      const hit = await resolveFullPlaylist(previewUrl);
      const targetUrl = (hit && hit.url) || previewUrl;
      const isFull = !!(hit && hit.url);

      const text = await (await fetch(targetUrl, { cache: 'no-store' })).text();
      const pl = parsePlaylist(text, targetUrl);
      if (!pl.segments.length) { badge('播放列表里没有分片'); return; }
      if (pl.hasByteRange) { badge('这个列表用了 EXT-X-BYTERANGE，本版本下载器还没支持'); return; }

      const total = pl.segments.length;
      LOG(`下载目标：${isFull ? '完整版' : '试看'} · ${total} 段 · ${pl.duration.toFixed(1)}s`
        + ` · ${pl.map ? 'fMP4' : 'MPEG-TS'}`);

      // ③ 密钥 + 首段验证（首段顺带拿到，后面不重复下）
      let cryptoKey = null, cachedFirst = null;
      if (pl.key) {
        badge('解密钥 + 验证首段…');
        const dec = await resolveDecryptKey(pl, targetUrl, previewUrl);
        cryptoKey = dec.cryptoKey;
        cachedFirst = dec.probe && dec.probe.plain;
      }

      const grab = async (i) => {
        if (i === 0 && cachedFirst) return cachedFirst;
        const seg = pl.segments[i];
        const buf = await fetchBytes(seg.url);
        if (!cryptoKey) return buf;
        return new Uint8Array(await crypto.subtle.decrypt(
          { name: 'AES-CBC', iv: ivForSegment(pl, seg) }, cryptoKey, buf));
      };

      const parts = writable ? null : [];
      const write = writable ? (c) => writable.write(c) : async (c) => { parts.push(c); };

      // 播放列表自带 fMP4 初始化分片时，它必须排在最前面（同样可能是加密的）
      if (pl.map) {
        const init = await fetchBytes(pl.map);
        const initPlain = cryptoKey
          ? new Uint8Array(await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: ivForSegment(pl, { seq: pl.mediaSequence }) }, cryptoKey, init))
          : init;
        await write(initPlain);
      }

      // ④ 并发抓、按序落盘
      const ahead = Math.max(1, Math.min(CFG.downloadConcurrency | 0 || 6, 12));
      const pending = new Map();
      let fetched = 0, written = 0;

      const prime = () => {
        while (fetched < total && pending.size < ahead) {
          pending.set(fetched, grab(fetched));
          fetched++;
        }
      };
      prime();

      while (written < total) {
        if (downloadCancelled) throw new Error('已取消');
        const chunk = await pending.get(written);
        pending.delete(written);
        await write(chunk);
        written++;
        prime();
        if (written === total || written % 5 === 0) {
          badge(`下载中 ${written}/${total} · ${Math.round((written / total) * 100)}%`);
        }
      }

      const nice = `${quickTitle()}_${isFull ? '完整版' : '试看'}`;
      lastSavedName = `${nice}.ts`;
      const tip = '\n需要 mp4 的话：点"复制 ffmpeg 命令"';
      if (writable) {
        await writable.close();
        writable = null;
        badge(`已保存 · ${total} 段 · ${pl.duration.toFixed(1)}s${isFull ? ' · 完整版' : ' · 试看'}${tip}`);
      } else {
        const blob = new Blob(parts, { type: 'video/mp2t' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = lastSavedName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 120000);
        badge(`已下载 ${(blob.size / 1048576).toFixed(1)} MB · ${total} 段${isFull ? ' · 完整版' : ' · 试看'}${tip}`);
      }
    } catch (e) {
      if (writable) { try { await writable.abort(); } catch (x) {} }
      badge('下载失败: ' + (e && e.message ? e.message : String(e)));
      WARN('下载失败', e);
    } finally {
      downloadBusy = false;
      downloadCancelled = false;
    }
  }

  /* ---------------------------------------------------------------- 启动流程 */

  function boot() {
    setupAds();
    setupNotices();
    hookHls();
    floatingActions();
    LOG('已加载 · 油猴脚本 v1.3.0');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

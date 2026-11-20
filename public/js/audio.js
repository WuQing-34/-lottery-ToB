/* ============================================================
   音效控制（Web Audio API）
   - 优先尝试 /audio/custom.mp3（把爱给网下载的音效丢进去即可自动启用）
   - 否则使用 public/audio/ 下的合成音效
   ============================================================ */
(function (global) {
  'use strict';

  const FILES = {
    tick: '/audio/tick.wav',
    win: '/audio/win.wav',
    fail: '/audio/fail.wav',
    click: '/audio/click.wav',
  };
  const CUSTOM_WIN = '/audio/custom'; // 依次尝试 .mp3 / .wav / .ogg

  let ctx = null;
  const buffers = {};
  let enabled = true;
  let loading = null;
  let customLoaded = false;

  function AC() {
    if (!ctx) {
      const C = global.AudioContext || global.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    return ctx;
  }

  async function fetchBuffer(url) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const arr = await res.arrayBuffer();
    return new Promise((resolve, reject) => {
      // Safari 只支持回调式
      const p = AC().decodeAudioData(arr, resolve, reject);
      if (p && p.then) p.then(resolve).catch(reject);
    });
  }

  async function loadAll() {
    if (loading) return loading;
    const ac = AC();
    if (!ac) return null;
    loading = (async () => {
      // 优先尝试自定义中奖音效
      for (const ext of ['.mp3', '.wav', '.ogg', '.m4a']) {
        try {
          buffers.win = await fetchBuffer(CUSTOM_WIN + ext);
          customLoaded = true;
          break;
        } catch (_) { /* 继续尝试 */ }
      }
      if (!buffers.win) {
        try { buffers.win = await fetchBuffer(FILES.win); } catch (_) {}
      }
      await Promise.all([
        fetchBuffer(FILES.tick).then((b) => (buffers.tick = b)).catch(() => {}),
        fetchBuffer(FILES.fail).then((b) => (buffers.fail = b)).catch(() => {}),
        fetchBuffer(FILES.click).then((b) => (buffers.click = b)).catch(() => {}),
      ]);
    })();
    return loading;
  }

  function play(name, opts) {
    if (!enabled) return;
    const ac = AC();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const buf = buffers[name];
    if (!buf) return;
    const o = opts || {};
    const src = ac.createBufferSource();
    src.buffer = buf;
    if (o.rate) src.playbackRate.value = o.rate;
    const g = ac.createGain();
    g.gain.value = o.volume === undefined ? 1 : o.volume;
    src.connect(g).connect(ac.destination);
    try { src.start(0); } catch (_) {}
    return src;
  }

  function unlock() {
    const ac = AC();
    if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    loadAll().catch(() => {});
  }

  const Sound = {
    unlock,
    load: loadAll,
    tick(rate) { play('tick', { rate: rate || 0.9 + Math.random() * 0.25, volume: 0.5 }); },
    win() { play('win', { volume: 0.95 }); },
    fail() { play('fail', { volume: 0.7 }); },
    click() { play('click', { volume: 0.4 }); },
    setEnabled(v) { enabled = !!v; },
    isEnabled() { return enabled; },
    usingCustom() { return customLoaded; },
  };

  // 首次交互时解锁音频（浏览器自动播放策略）
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
    global.addEventListener(ev, () => Sound.unlock(), { once: true, passive: true });
  });

  global.Sound = Sound;
})(window);

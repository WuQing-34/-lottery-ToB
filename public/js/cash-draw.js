/* ============================================================
   CC 团队现金抽奖页：独立奖池 / 独立次数 / 概率可控
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------------- CC 现金抽奖固定标识 ---------------- */
  const NAME_KEY = 'luckywheel.cash.name';
  const SOUND_KEY = 'luckywheel.sound';

  const state = {
    segments: [],
    player: null,
    name: localStorage.getItem(NAME_KEY) || '',
    spinning: false,
    busy: false,
    lastLeft: 0,
    teamName: 'CC 现金抽奖',
  };

  // 支持 /cc?name=张三 直接带入姓名（展台大屏用）
  (function applyQueryName() {
    const q = new URLSearchParams(location.search).get('name');
    if (q && q.trim()) {
      state.name = q.trim();
      localStorage.setItem(NAME_KEY, state.name);
    }
  })();

  const canvas = $('wheel');
  const spinBtn = $('spinBtn');
  const pointer = $('pointer');
  const playerText = $('playerText');
  const changeNameBtn = $('changeNameBtn');

  const wheel = new Wheel(canvas, {
    palette: 'purple',
    onTick() {
      Sound.tick();
      pointer.classList.add('tick');
      clearTimeout(wheel._pt);
      wheel._pt = setTimeout(() => pointer.classList.remove('tick'), 55);
    },
  });

  /* ---------------- 请求封装 ---------------- */
  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error(data.message || `请求失败 (${res.status})`);
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------------- 提示 ---------------- */
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    $('toastHolder').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 320);
    }, 2200);
  }

  function showTip(title, desc) {
    $('tipTitle').textContent = title;
    $('tipDesc').textContent = desc;
    $('tipMask').hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- 音效开关 ---------------- */
  function renderSound() {
    const el = $('soundState');
    const on = Sound.isEnabled();
    el.textContent = on ? '🔊 音效开' : '🔇 音效关';
    el.className = 'tag ' + (on ? 'tag-green' : 'tag-gray');
  }

  Sound.setEnabled(localStorage.getItem(SOUND_KEY) !== 'off');
  renderSound();
  $('soundState').addEventListener('click', () => {
    const next = !Sound.isEnabled();
    Sound.setEnabled(next);
    localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
    renderSound();
    if (next) { Sound.unlock(); Sound.click(); }
  });

  /* ---------------- 团队标识 ---------------- */
  function applyTeamBrand(name) {
    state.teamName = name || 'CC 现金抽奖';
    $('teamBadge').textContent = '¥';
    $('teamLabel').textContent = 'CC 团队 · 现金奖池（与实物抽奖独立）';
    $('brandName').textContent = 'CC 现金抽奖';
    document.title = 'CC 团队 · 现金抽奖';
    $('nameDesc').textContent = '仅现金抽奖名单中的同事可以参与，次数与实物抽奖互不占用';
  }
  applyTeamBrand(state.teamName);

  /* ---------------- 数据加载 ---------------- */
  function applyWheel(w) {
    const prev = JSON.stringify(state.segments);
    state.segments = w.segments || [];
    if (w.teamName) applyTeamBrand(w.teamName);
    if (JSON.stringify(state.segments) !== prev) {
      wheel.setSegments(state.segments);
    }
    updateSpinBtn();
  }

  function updateSpinBtn() {
    if (state.spinning) return;
    if (!state.segments.length) {
      spinBtn.disabled = true;
      spinBtn.innerHTML = '<span><span class="main">暂无</span><span class="sub">奖品</span></span>';
      return;
    }
    spinBtn.disabled = false;
    spinBtn.innerHTML = '<span><span class="main">开始</span><span class="sub">抽奖</span></span>';
  }

  function renderPlayer() {
    const p = state.player;
    if (!state.name) {
      playerText.innerHTML = '请先输入姓名开始抽奖';
      changeNameBtn.textContent = '输入姓名';
      return;
    }
    changeNameBtn.textContent = '换个人';
    if (!p) {
      playerText.innerHTML = `<b class="player-name">${escapeHtml(state.name)}</b><span class="player-meta"> 未在抽奖名单中</span>`;
      return;
    }
    if (p.left > 0) {
      playerText.innerHTML = `<b class="player-name">${escapeHtml(p.name)}</b>`
        + `<span class="player-meta"> 已抽 ${p.used}/${p.chances} 次</span>`
        + `<span class="player-left">剩余 ${p.left} 次</span>`;
    } else {
      playerText.innerHTML = `<b class="player-name">${escapeHtml(p.name)}</b>`
        + `<span class="player-meta"> 抽奖次数已用完</span>`;
    }
  }

  async function loadWheel() {
    try {
      const w = await api('/api/cash/wheel');
      applyWheel(w);
    } catch (err) {
      toast('加载奖品失败：' + err.message, 'err');
    }
  }

  async function loadMe(silent) {
    if (!state.name) { state.player = null; renderPlayer(); return; }
    try {
      const r = await api('/api/cash/me?name=' + encodeURIComponent(state.name));
      state.player = r.participant;
    } catch (err) {
      state.player = null;
    }
    renderPlayer();
  }

  /* ---------------- 姓名输入 ---------------- */
  let nameResolve = null;

  function askName(opts) {
    const o = opts || {};
    $('nameInput').value = o.prefill !== undefined ? o.prefill : (state.name || '');
    $('nameDesc').textContent = o.desc || `仅${state.teamName}已登记的同事可以抽奖，姓名需与名单一致`;
    $('nameError').classList.remove('show');
    $('nameMask').hidden = false;
    setTimeout(() => $('nameInput').focus(), 60);
    if (o.tip) {
      $('nameError').textContent = o.tip;
      $('nameError').classList.add('show');
    }
    return new Promise((resolve) => { nameResolve = resolve; });
  }

  function closeName(value) {
    $('nameMask').hidden = true;
    if (nameResolve) { nameResolve(value); nameResolve = null; }
  }

  $('nameOk').addEventListener('click', async () => {
    const v = $('nameInput').value.trim();
    if (!v) {
      $('nameError').textContent = '请输入姓名';
      $('nameError').classList.add('show');
      return;
    }
    $('nameOk').disabled = true;
    try {
      const r = await api('/api/cash/me?name=' + encodeURIComponent(v));
      state.name = v;
      state.player = r.participant;
      localStorage.setItem(NAME_KEY, v);
      renderPlayer();
      closeName(v);
      Sound.click();
      toast(`欢迎你，${r.participant.name}`, 'ok');
    } catch (err) {
      $('nameError').textContent = err.message || '姓名校验失败';
      $('nameError').classList.add('show');
    } finally {
      $('nameOk').disabled = false;
    }
  });

  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('nameOk').click();
  });
  $('nameCancel').addEventListener('click', () => closeName(null));
  changeNameBtn.addEventListener('click', () => askName());

  /* ---------------- 抽奖 ---------------- */
  function lockBtn(lock) {
    state.busy = lock;
    spinBtn.disabled = lock;
    if (lock) {
      spinBtn.innerHTML = '<span><span class="main">转动</span><span class="sub">中…</span></span>';
    } else {
      updateSpinBtn();
    }
  }

  async function doDraw() {
    if (state.spinning || state.busy) return;

    if (!state.name) {
      const n = await askName();
      if (!n) return;
    }

    Sound.unlock();
    Sound.click();
    lockBtn(true);

    let data;
    try {
      data = await api('/api/cash/draw', {
        method: 'POST',
        body: JSON.stringify({ name: state.name }),
      });
    } catch (err) {
      lockBtn(false);
      Sound.fail();
      if (err.code === 'NO_CHANCE') {
        showTip('现金次数已用完', err.message);
        loadMe();
      } else if (err.code === 'NOT_REGISTERED') {
        state.player = null;
        renderPlayer();
        showTip('不在现金名单中', err.message);
        askName({ tip: '请联系管理员把你加入现金抽奖名单，实物抽奖名单不通用' });
      } else if (err.code === 'NO_STOCK') {
        showTip('现金奖池已发完', err.message);
      } else if (err.code === 'TOO_FAST') {
        toast(err.message, 'err');
      } else {
        showTip('现金抽奖失败', err.message || '请稍后重试');
      }
      return;
    }

    let idx = data.index;
    if (!state.segments[idx] || state.segments[idx].id !== data.prize.id) {
      const found = state.segments.findIndex((s) => s.id === data.prize.id);
      if (found >= 0) {
        idx = found;
      } else {
        await loadWheel();
        const f2 = state.segments.findIndex((s) => s.id === data.prize.id);
        idx = f2 >= 0 ? f2 : 0;
      }
    }

    state.spinning = true;
    spinBtn.disabled = true;
    await wheel.spinTo(idx, { turns: 6 });
    state.spinning = false;
    lockBtn(false);

    Sound.win();
    showResult(data);
  }

  function showResult(data) {
    $('resultWho').textContent = `恭喜 ${data.record.name}！`;
    $('resultPrize').textContent = data.record.prizeName;
    $('resultAmount').textContent = data.record.amount > 1 ? `本次发放 ${data.record.amount} 份` : '';

    const left = data.remaining;
    state.lastLeft = left;
    $('resultLeft').textContent = left > 0
      ? `你还有 ${left} 次现金抽奖机会，关闭后确认姓名即可继续抽`
      : '现金抽奖次数已用完，关闭后请下一位同事输入姓名';

    makeConfetti();
    $('resultMask').hidden = false;

    loadWheel();
    loadMe();
  }

  function makeConfetti() {
    const box = $('confetti');
    box.innerHTML = '';
    const colors = ['#8b4fd8', '#b98af0', '#ffd166', '#ffe08a', '#ffffff', '#6a35bd'];
    for (let i = 0; i < 30; i += 1) {
      const s = document.createElement('i');
      s.style.left = Math.random() * 100 + '%';
      s.style.background = colors[Math.floor(Math.random() * colors.length)];
      s.style.animationDuration = (1.1 + Math.random() * 1.1) + 's';
      s.style.animationDelay = (Math.random() * 0.5) + 's';
      s.style.width = (5 + Math.random() * 6) + 'px';
      s.style.height = (9 + Math.random() * 9) + 'px';
      s.style.opacity = 0.75 + Math.random() * 0.25;
      box.appendChild(s);
    }
  }

  // 关闭中奖弹窗后自动回到「姓名填写页」，下一位同事直接输入即可，不需要点「换个人」
  $('resultOk').addEventListener('click', () => {
    $('resultMask').hidden = true;
    Sound.click();
    $('confetti').innerHTML = '';

    const left = Number(state.lastLeft || 0);
    const keep = left > 0 ? state.name : '';

    state.name = '';
    state.player = null;
    state.lastLeft = 0;
    localStorage.removeItem(NAME_KEY);
    renderPlayer();

    askName({
      prefill: keep,
      desc: left > 0
        ? `${keep} 还有 ${left} 次机会，确认姓名可继续抽；下一位同事直接改成自己的名字即可`
        : '请下一位同事输入姓名开始抽奖',
    });
  });

  $('tipOk').addEventListener('click', () => {
    $('tipMask').hidden = true;
  });

  spinBtn.addEventListener('click', doDraw);

  /* ---------------- 实时同步（SSE） ---------------- */
  let pending = null;
  function scheduleRefresh() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (state.spinning) { scheduleRefresh(); return; }
      loadWheel();
      loadMe(true);
    }, 400);
  }

  function connectSSE() {
    try {
      const es = new EventSource('/api/events');
      es.addEventListener('state', scheduleRefresh);
      es.onerror = () => {
        es.close();
        setTimeout(connectSSE, 3000);
      };
    } catch (_) {}
  }

  /* ---------------- 启动 ---------------- */
  (async function init() {
    await loadWheel();
    if (state.name) await loadMe();
    if (!state.name) askName();
    connectSSE();
    Sound.load();
  })();

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space' || e.key === 'Enter') {
      if (!$('nameMask').hidden || !$('resultMask').hidden || !$('tipMask').hidden) return;
      e.preventDefault();
      doDraw();
    }
  });
})();

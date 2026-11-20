/* ============================================================
   管理后台逻辑（CC / LP 双团队）
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'luckywheel.adminToken';
  const TEAM_KEY = 'luckywheel.adminTeam';

  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let team = sessionStorage.getItem(TEAM_KEY) || 'cc';
  let state = {
    prizes: [], participants: [], records: [], logs: [],
    stats: {}, config: {}, wheel: { segments: [], overflow: [] },
    overview: [], teams: [],
  };
  let currentTab = 'stock';

  /* ---------------- 基础工具 ---------------- */
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return d.toDateString() === new Date().toDateString()
      ? `今天 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function teamName(id) {
    const t = state.teams.find((x) => x.id === id);
    if (t) return t.name;
    const cfg = state.config.teams || {};
    return cfg[id] || String(id).toUpperCase();
  }

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
    }, 2400);
  }

  async function api(path, opts) {
    const o = Object.assign({}, opts);
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    if (token) o.headers['x-admin-token'] = token;
    const res = await fetch(path, o);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401) {
      logout(true);
      throw new Error('登录已失效，请重新登录');
    }
    if (!res.ok) throw new Error(data.message || `请求失败 (${res.status})`);
    return data;
  }

  async function downloadFile(url, fallbackName) {
    const res = await fetch(url, { headers: { 'x-admin-token': token } });
    if (!res.ok) {
      let msg = '导出失败';
      try { msg = (await res.json()).message || msg; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    let name = fallbackName;
    const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) name = decodeURIComponent(star[1]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------------- 登录 ---------------- */
  function showLogin() {
    $('loginView').hidden = false;
    $('appView').hidden = true;
  }

  function showApp() {
    $('loginView').hidden = true;
    $('appView').hidden = false;
  }

  function logout(silent) {
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    showLogin();
    if (!silent) toast('已退出登录');
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = $('loginPwd').value;
    $('loginError').classList.remove('show');
    $('loginBtn').disabled = true;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || '登录失败');
      token = data.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      showApp();
      await loadState();
      connectSSE();
    } catch (err) {
      $('loginError').textContent = err.message;
      $('loginError').classList.add('show');
    } finally {
      $('loginBtn').disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', () => logout(false));

  /* ---------------- 数据加载 ---------------- */
  async function loadState(silent) {
    try {
      const data = await api('/api/admin/state?team=' + encodeURIComponent(team));
      state = {
        prizes: data.prizes || [],
        participants: data.participants || [],
        records: data.records || [],
        logs: data.logs || [],
        stats: data.stats || {},
        config: data.config || {},
        wheel: data.wheel || { segments: [], overflow: [] },
        overview: data.overview || [],
        teams: data.teams || [],
      };
      renderAll();
      if (silent !== true) {
        $('lastSync').textContent = '更新于 ' + fmtShort(new Date().toISOString());
      }
    } catch (err) {
      if (token) toast(err.message, 'err');
    }
  }

  /* ---------------- 渲染：团队总览 ---------------- */
  function renderOverview() {
    const box = $('overviewBox');
    if (!box) return;
    const teams = state.overview.length
      ? state.overview
      : [{ id: 'cc', name: 'CC 团队' }, { id: 'lp', name: 'LP 团队' }];
    box.innerHTML = teams.map((t) => `
      <div class="ov-card ${t.id} ${t.id === team ? 'active' : ''}" data-team="${t.id}">
        <div class="ov-top">
          <span class="ov-badge">${t.id.toUpperCase()}</span>
          <div>
            <div class="ov-name">${esc(t.name || t.id.toUpperCase())}</div>
            <div class="ov-sub">${t.id === team ? '当前管理范围' : '点击切换'}</div>
          </div>
        </div>
        <div class="ov-metrics">
          <div><b>${t.prizeCount || 0}</b>奖品</div>
          <div><b>${t.totalStock || 0}</b>剩余件</div>
          <div><b>${t.availableWins || 0}</b>可抽次</div>
          <div><b>${t.readyCount || 0}</b>可抽人</div>
        </div>
      </div>
    `).join('');
    [...box.querySelectorAll('.ov-card')].forEach((el) => {
      el.addEventListener('click', () => switchTeam(el.dataset.team));
    });
  }

  function switchTeam(next) {
    if (!next || next === team) return;
    team = next;
    sessionStorage.setItem(TEAM_KEY, team);
    [...$('teamSwitch').children].forEach((b) => b.classList.toggle('active', b.dataset.team === team));
    loadState();
  }

  $('teamSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-team]');
    if (btn) switchTeam(btn.dataset.team);
  });

  /* ---------------- 渲染：看板 ---------------- */
  function renderStats() {
    const s = state.stats || {};
    const cards = [
      { k: '礼品种类', v: s.prizeCount || 0 },
      { k: '剩余库存（件）', v: s.totalStock || 0, cls: 'gold' },
      { k: '已发放（件）', v: s.totalAwarded || 0, cls: 'accent' },
      { k: '剩余可抽次数', v: s.availableWins || 0, cls: 'gold' },
      { k: '抽奖人', v: s.participantCount || 0 },
      { k: '当前可抽奖', v: s.readyCount || 0, cls: 'accent' },
      { k: '抽奖记录', v: s.recordCount || 0 },
    ];
    $('stats').innerHTML = cards.map((c) => (
      `<div class="stat ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`
    )).join('');
  }

  /* ---------------- 渲染：礼品 ---------------- */
  function prizeStatus(p) {
    if (p.stock <= 0) return '<span class="tag tag-red">已发完</span>';
    if (p.remainingWins <= 0) return '<span class="tag tag-gold">不足一份</span>';
    if (p.remainingWins <= 2) return '<span class="tag tag-gold">库存紧张</span>';
    return '<span class="tag tag-green">有货</span>';
  }

  function renderPrizes() {
    const list = state.prizes;
    $('prizeEmpty').hidden = list.length > 0;
    $('prizeBody').innerHTML = list.map((p) => {
      const pct = p.initial > 0 ? Math.min(100, Math.round((p.stock / p.initial) * 100)) : 0;
      const low = pct <= 20 ? 'low' : '';
      return `<tr>
        <td class="name-cell">${esc(p.name)}</td>
        <td class="right num-cell">${p.initial}</td>
        <td class="right num-cell">${p.awarded}</td>
        <td class="right num-cell"><b>${p.stock}</b></td>
        <td class="right num-cell">${p.perDraw}</td>
        <td class="right num-cell">${p.remainingWins}</td>
        <td><div class="stock-bar ${low}"><i style="width:${pct}%"></i></div></td>
        <td>${prizeStatus(p)}</td>
        <td class="right">
          <div class="actions">
            <button class="btn btn-sm" data-act="restock" data-id="${p.id}">补货</button>
            <button class="btn btn-sm" data-act="edit-prize" data-id="${p.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="del-prize" data-id="${p.id}">删除</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ---------------- 渲染：抽奖人 ---------------- */
  function renderPeople() {
    const q = ($('peopleSearch').value || '').trim().toLowerCase();
    const list = state.participants.filter((p) => !q || p.name.toLowerCase().includes(q));
    $('peopleCount').textContent = `${state.participants.length} 人`;
    $('peopleEmpty').hidden = list.length > 0;
    if (!list.length) {
      $('peopleBody').innerHTML = '';
      return;
    }
    $('peopleBody').innerHTML = list.map((p) => {
      let tag = '<span class="tag tag-gray">未开始</span>';
      if (p.left > 0) tag = '<span class="tag tag-green">可抽奖</span>';
      else if (p.used > 0) tag = '<span class="tag tag-red">已抽奖</span>';
      return `<tr>
        <td class="name-cell">${esc(p.name)}</td>
        <td class="right num-cell">${p.chances}</td>
        <td class="right num-cell">${p.used}</td>
        <td class="right num-cell"><b>${p.left}</b></td>
        <td>${tag}</td>
        <td class="hint">${p.lastDrawnAt ? fmtTime(p.lastDrawnAt) : '—'}</td>
        <td class="hint">${fmtTime(p.createdAt)}</td>
        <td class="right">
          <div class="actions">
            <button class="btn btn-sm btn-gold" data-act="add-chance" data-id="${p.id}">＋次数</button>
            <button class="btn btn-sm" data-act="edit-person" data-id="${p.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="del-person" data-id="${p.id}">删除</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ---------------- 渲染：记录 ---------------- */
  function renderRecords() {
    const list = state.records;
    $('recordCount').textContent = `${state.stats.recordCount || 0} 条`;
    $('recordEmpty').hidden = list.length > 0;
    $('recordBody').innerHTML = list.map((r, i) => {
      let push = '<span class="tag tag-gray">—</span>';
      if (r.push && r.push.status === 'ok') push = '<span class="tag tag-green">已推送</span>';
      else if (r.push && r.push.status === 'fail') push = `<span class="tag tag-red" title="${esc(r.push.message)}">推送失败</span>`;
      else if (r.push && r.push.status === 'pending') push = '<span class="tag tag-gold">推送中</span>';
      return `<tr>
        <td class="hint num-cell">${i + 1}</td>
        <td class="name-cell">${esc(r.name)}</td>
        <td><b>${esc(r.prizeName)}</b></td>
        <td class="right num-cell">${r.amount || 1}</td>
        <td class="hint">${fmtTime(r.time)}</td>
        <td>${push}</td>
      </tr>`;
    }).join('');

    $('logBody').innerHTML = state.logs.map((l) => (
      `<tr><td class="hint" style="width:150px">${fmtTime(l.time)}</td><td>${esc(l.text)}</td></tr>`
    )).join('') || '<tr><td class="hint" style="padding:14px 16px">暂无日志</td></tr>';
  }

  /* ---------------- 渲染：设置 ---------------- */
  function renderSettings() {
    const c = state.config || {};
    const setIfIdle = (id, val) => {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = val;
    };
    setIfIdle('cfgWebhook', c.webhook || '');
    if (document.activeElement !== $('cfgSecret')) $('cfgSecret').value = c.secret || '';
    setIfIdle('cfgSegments', String(c.maxSegments || 12));
    setIfIdle('cfgSound', c.soundOn ? '1' : '0');
    setIfIdle('cfgAtAll', c.atAll ? '1' : '0');
    const tm = c.teams || {};
    setIfIdle('cfgTeamCc', tm.cc || 'CC 团队');
    setIfIdle('cfgTeamLp', tm.lp || 'LP 团队');
    const sr = c.stockReport || {};
    setIfIdle('cfgReportOn', sr.on === false ? '0' : '1');
    setIfIdle('cfgReportTime', sr.time || '18:30');
    $('pwdHint').textContent = c.passwordIsDefault ? '当前仍在使用默认密码 CHANGE_ME_2026，建议尽快修改' : '密码已自定义';

    const seg = (state.wheel && state.wheel.segments) || [];
    const overflow = (state.wheel && state.wheel.overflow) || [];
    $('wheelOverflow').innerHTML = overflow.length
      ? `<span style="color:var(--red)">⚠ ${teamName(team)}有 ${overflow.length} 个奖品超出转盘格数（${overflow.map(esc).join('、')}），暂不参与抽奖</span>`
      : `当前${teamName(team)}转盘 ${seg.length} 个奖品`;
  }

  function renderTeamLabels() {
    const name = teamName(team);
    $('importTeamTag').textContent = name;
    $('dangerScope').textContent = name;
    [...$('teamSwitch').children].forEach((b) => {
      b.classList.toggle('active', b.dataset.team === team);
      b.textContent = teamName(b.dataset.team);
    });
  }

  function renderAll() {
    renderTeamLabels();
    renderOverview();
    renderStats();
    renderPrizes();
    renderPeople();
    renderRecords();
    renderSettings();
  }

  /* ---------------- Excel 导入 ---------------- */
  let parsedRows = null;
  let importMode = 'merge';

  $('importMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    importMode = btn.dataset.mode;
    [...$('importMode').children].forEach((b) => b.classList.toggle('active', b === btn));
  });

  $('dropzone').addEventListener('click', () => $('fileInput').click());
  $('dropzone').addEventListener('dragover', (e) => {
    e.preventDefault();
    $('dropzone').classList.add('over');
  });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('over'));
  $('dropzone').addEventListener('drop', (e) => {
    e.preventDefault();
    $('dropzone').classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readExcel(f);
  });
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) readExcel(f);
    e.target.value = '';
  });

  const NAME_KEYS = ['礼品', '奖品', '名称', '物品', '商品', '奖项', '产品'];
  const PER_KEYS = ['每次', '发放', '单次', '每份', '单份'];
  const STOCK_KEYS = ['库存', '数量', '总数', '剩余', '份数', '个数'];

  function parseMatrix(matrix) {
    const norm = matrix.map((row) => (row || []).map((c) => String(c === undefined || c === null ? '' : c).trim()));
    let headerIdx = -1;
    let map = null;
    for (let i = 0; i < Math.min(norm.length, 12); i += 1) {
      const row = norm[i];
      const m = {};
      row.forEach((cell, ci) => {
        if (!cell) return;
        if (m.name === undefined && NAME_KEYS.some((k) => cell.includes(k))) { m.name = ci; return; }
        if (m.per === undefined && PER_KEYS.some((k) => cell.includes(k))) { m.per = ci; return; }
        if (m.stock === undefined && STOCK_KEYS.some((k) => cell.includes(k))) { m.stock = ci; }
      });
      if (m.name !== undefined && m.stock !== undefined) { headerIdx = i; map = m; break; }
    }
    if (headerIdx < 0) {
      map = { name: 0, stock: 1, per: 2 };
      headerIdx = -1;
    }
    const rows = [];
    const toNum = (v) => {
      const n = Number(String(v).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    for (let i = headerIdx + 1; i < norm.length; i += 1) {
      const row = norm[i];
      const name = row[map.name];
      if (!name) continue;
      if (NAME_KEYS.some((k) => name.includes(k)) && String(name).length < 12) continue;
      const stock = map.stock !== undefined ? toNum(row[map.stock]) : 0;
      const per = map.per !== undefined ? toNum(row[map.per]) || 1 : 1;
      if (!stock && !row[map.stock]) continue;
      rows.push({ name, stock, perDraw: Math.max(1, per) });
    }
    return rows;
  }

  function readExcel(file) {
    if (typeof XLSX === 'undefined') {
      toast('Excel 解析库未加载，请刷新页面重试', 'err');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
        const rows = parseMatrix(matrix);
        if (!rows.length) {
          $('previewBox').innerHTML = '<div class="warn-box">没有解析到有效数据，请检查表格是否包含「礼品名称 / 库存数量 / 每次发放数量」三列。</div>';
          parsedRows = null;
          return;
        }
        parsedRows = rows;
        renderPreview(file.name);
      } catch (err) {
        $('previewBox').innerHTML = `<div class="warn-box">解析失败：${esc(err.message)}</div>`;
        parsedRows = null;
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderPreview(fileName) {
    const rows = parsedRows || [];
    const totalWins = rows.reduce((s, r) => s + Math.floor(r.stock / r.perDraw), 0);
    const shown = rows.slice(0, 12);
    $('previewBox').innerHTML = `
      <div class="between" style="margin-bottom:8px">
        <div><b>${esc(fileName)}</b> <span class="hint">解析到 ${rows.length} 个礼品</span></div>
        <span class="tag tag-gold">共可抽 ${totalWins} 次</span>
      </div>
      <div class="preview-table">
        <table class="grid">
          <thead><tr><th>#</th><th>礼品名称</th><th class="right">库存</th><th class="right">每次发放</th><th class="right">可抽次数</th></tr></thead>
          <tbody>
            ${shown.map((r, i) => `<tr>
              <td class="hint num-cell">${i + 1}</td>
              <td class="name-cell">${esc(r.name)}</td>
              <td class="right num-cell">${r.stock}</td>
              <td class="right num-cell">${r.perDraw}</td>
              <td class="right num-cell">${Math.floor(r.stock / r.perDraw)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${rows.length > shown.length ? `<div class="hint mt8">仅预览前 ${shown.length} 条，导入时会处理全部 ${rows.length} 条</div>` : ''}
      <div class="row mt12">
        <button class="btn btn-primary" id="confirmImport" type="button">导入到 ${esc(teamName(team))}（${importMode === 'merge' ? '合并' : '覆盖'}）</button>
        <button class="btn" id="cancelImport" type="button">取消</button>
      </div>
    `;
    $('confirmImport').addEventListener('click', doImport);
    $('cancelImport').addEventListener('click', () => {
      parsedRows = null;
      $('previewBox').innerHTML = '';
    });
  }

  async function doImport() {
    if (!parsedRows || !parsedRows.length) return;
    const btn = $('confirmImport');
    btn.disabled = true;
    try {
      const res = await api('/api/admin/prizes/import', {
        method: 'POST',
        body: JSON.stringify({ rows: parsedRows, mode: importMode, team }),
      });
      toast(`导入成功：新增 ${res.created} 个，更新 ${res.updated} 个`, 'ok');
      parsedRows = null;
      $('previewBox').innerHTML = '';
      await loadState();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  }

  $('tplBtn').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') {
      toast('Excel 库未加载', 'err');
      return;
    }
    const aoa = [
      ['礼品名称', '库存数量', '每次发放数量'],
      ['保温杯', 10, 1],
      ['蓝牙音箱', 5, 1],
      ['100元购物卡', 3, 1],
      ['定制帆布袋', 20, 2],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '礼品库存');
    XLSX.writeFile(wb, `礼品导入模板-${teamName(team)}.xlsx`);
  });

  /* ---------------- 导出库存 ---------------- */
  $('exportInvBtn').addEventListener('click', async () => {
    try {
      await downloadFile(`/api/admin/export/inventory.xlsx?team=${encodeURIComponent(team)}`, `库存表-${teamName(team)}.xlsx`);
      toast('库存表已导出', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  $('exportAllInv').addEventListener('click', async () => {
    try {
      await downloadFile('/api/admin/export/inventory.xlsx?team=all', '库存表-全部团队.xlsx');
      toast('全部团队库存表已导出', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ---------------- 通用表单弹窗 ---------------- */
  let formResolve = null;
  let formFieldsDef = [];

  function openForm(cfg) {
    formFieldsDef = cfg.fields || [];
    $('formTitle').textContent = cfg.title || '编辑';
    $('formDesc').textContent = cfg.desc || '';
    $('formDesc').hidden = !cfg.desc;
    $('formOk').textContent = cfg.okText || '确定';
    $('formError').classList.remove('show');

    const box = $('formFields');
    box.innerHTML = formFieldsDef.map((f, i) => `
      <div class="field" style="margin-bottom:12px">
        <label for="ff_${i}">${esc(f.label)}</label>
        <input class="input" id="ff_${i}" type="${f.type || 'text'}" value="${esc(f.value === undefined ? '' : f.value)}"
          placeholder="${esc(f.placeholder || '')}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.step ? `step="${f.step}"` : ''}>
        ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}
      </div>
    `).join('');

    $('formMask').hidden = false;
    setTimeout(() => {
      const first = box.querySelector('input');
      if (first) { first.focus(); first.select(); }
    }, 60);

    return new Promise((resolve) => { formResolve = resolve; });
  }

  function closeForm(result) {
    $('formMask').hidden = true;
    if (formResolve) { formResolve(result); formResolve = null; }
  }

  function collectForm() {
    const out = {};
    formFieldsDef.forEach((f, i) => {
      out[f.key] = $('ff_' + i).value;
    });
    return out;
  }

  $('formOk').addEventListener('click', () => closeForm(collectForm()));
  $('formCancel').addEventListener('click', () => closeForm(null));
  $('formFields').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeForm(collectForm()); }
  });

  /* ---------------- 确认弹窗 ---------------- */
  let confirmResolve = null;
  function confirmBox(title, desc, okText) {
    $('confirmTitle').textContent = title;
    $('confirmDesc').textContent = desc;
    $('confirmOk').textContent = okText || '确认执行';
    $('confirmMask').hidden = false;
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  $('confirmOk').addEventListener('click', () => {
    $('confirmMask').hidden = true;
    if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
  });
  $('confirmCancel').addEventListener('click', () => {
    $('confirmMask').hidden = true;
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  });

  /* ---------------- 礼品操作 ---------------- */
  $('addPrizeBtn').addEventListener('click', async () => {
    const v = await openForm({
      title: `新增礼品 · ${teamName(team)}`,
      desc: '同名礼品会直接更新库存',
      fields: [
        { key: 'name', label: '礼品名称', placeholder: '例如：保温杯' },
        { key: 'stock', label: '库存数量', type: 'number', value: 10, min: 0 },
        { key: 'perDraw', label: '每次发放数量', type: 'number', value: 1, min: 1, hint: '抽中一次扣减的件数' },
      ],
    });
    if (!v) return;
    try {
      await api('/api/admin/prizes', { method: 'POST', body: JSON.stringify({ ...v, team }) });
      toast('已保存', 'ok');
      loadState();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('prizeBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const p = state.prizes.find((x) => x.id === id);
    if (!p) return;

    if (btn.dataset.act === 'del-prize') {
      const ok = await confirmBox('删除礼品', `确定删除「${p.name}」吗？该礼品将从${teamName(team)}的转盘移除，历史记录保留。`, '删除');
      if (!ok) return;
      try { await api('/api/admin/prizes/' + id, { method: 'DELETE' }); toast('已删除', 'ok'); loadState(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }

    if (btn.dataset.act === 'restock') {
      const v = await openForm({
        title: `补货 · ${p.name}`,
        desc: `当前剩余 ${p.stock} 件，已发放 ${p.awarded} 件`,
        okText: '保存库存',
        fields: [{ key: 'stock', label: '调整后的剩余库存', type: 'number', value: p.stock, min: 0 }],
      });
      if (!v) return;
      try {
        await api(`/api/admin/prizes/${id}/restock`, { method: 'POST', body: JSON.stringify({ stock: v.stock }) });
        toast('库存已更新', 'ok');
        loadState();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    if (btn.dataset.act === 'edit-prize') {
      const v = await openForm({
        title: '编辑礼品',
        fields: [
          { key: 'name', label: '礼品名称', value: p.name },
          { key: 'stock', label: '剩余库存', type: 'number', value: p.stock, min: 0 },
          { key: 'perDraw', label: '每次发放数量', type: 'number', value: p.perDraw, min: 1 },
        ],
      });
      if (!v) return;
      try {
        await api('/api/admin/prizes', { method: 'POST', body: JSON.stringify({ id, team, ...v }) });
        toast('已保存', 'ok');
        loadState();
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  /* ---------------- 抽奖人操作 ---------------- */
  $('singleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('pName').value.trim();
    const chances = Number($('pChances').value) || 1;
    if (!name) { toast('请输入姓名', 'err'); return; }
    try {
      const res = await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name, chances, team }) });
      toast(res.merged ? `已为「${name}」追加 ${chances} 次` : `已添加「${name}」到${teamName(team)}`, 'ok');
      $('pName').value = '';
      $('pChances').value = 1;
      $('pName').focus();
      loadState();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('addMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    const batch = btn.dataset.mode === 'batch';
    [...$('addMode').children].forEach((b) => b.classList.toggle('active', b === btn));
    $('singleForm').hidden = batch;
    $('batchForm').hidden = !batch;
  });

  $('batchSubmit').addEventListener('click', async () => {
    const lines = $('batchText').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { toast('请输入内容', 'err'); return; }
    let ok = 0; let fail = 0;
    const btn = $('batchSubmit');
    btn.disabled = true;
    for (const line of lines) {
      const parts = line.split(/[,，\t\s]+/).filter(Boolean);
      const name = parts[0];
      const chances = parts[1] ? Number(parts[1]) || 1 : 1;
      try {
        await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name, chances, team }) });
        ok += 1;
      } catch (_) { fail += 1; }
    }
    btn.disabled = false;
    $('batchText').value = '';
    toast(`批量添加完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`, ok ? 'ok' : 'err');
    loadState();
  });

  $('peopleSearch').addEventListener('input', renderPeople);

  $('peopleBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const p = state.participants.find((x) => x.id === id);
    if (!p) return;

    if (btn.dataset.act === 'del-person') {
      const ok = await confirmBox('删除抽奖人', `确定删除「${p.name}」吗？其抽奖记录会保留。`, '删除');
      if (!ok) return;
      try { await api('/api/admin/participants/' + id, { method: 'DELETE' }); toast('已删除', 'ok'); loadState(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }

    if (btn.dataset.act === 'add-chance') {
      const v = await openForm({
        title: `追加抽奖次数 · ${p.name}`,
        desc: `当前总次数 ${p.chances}，已抽 ${p.used} 次，剩余 ${p.left} 次`,
        okText: '追加',
        fields: [{ key: 'add', label: '追加次数', type: 'number', value: 1, min: 1 }],
      });
      if (!v) return;
      try {
        await api('/api/admin/participants/' + id, { method: 'PATCH', body: JSON.stringify({ addChances: Number(v.add) || 1 }) });
        toast(`已为「${p.name}」追加次数`, 'ok');
        loadState();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    if (btn.dataset.act === 'edit-person') {
      const v = await openForm({
        title: '编辑抽奖人',
        fields: [
          { key: 'name', label: '姓名', value: p.name },
          { key: 'chances', label: '总抽奖次数', type: 'number', value: p.chances, min: p.used, hint: `已抽 ${p.used} 次，不能小于该值` },
        ],
      });
      if (!v) return;
      try {
        await api('/api/admin/participants/' + id, { method: 'PATCH', body: JSON.stringify(v) });
        toast('已保存', 'ok');
        loadState();
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  /* ---------------- 记录 / 导出 ---------------- */
  $('clearRecords').addEventListener('click', async () => {
    const ok = await confirmBox('清空抽奖记录', `将删除${teamName(team)}的所有抽奖记录（不影响库存与名单），确定吗？`, '清空');
    if (!ok) return;
    try {
      await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'records', team }) });
      toast('已清空', 'ok');
      loadState();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('exportBtn').addEventListener('click', exportRecords);
  const legacyExport = $('exportCsv');
  if (legacyExport) {
    legacyExport.addEventListener('click', (e) => { e.preventDefault(); exportRecords(); });
  }

  async function exportRecords() {
    try {
      await downloadFile(`/api/admin/export?team=${encodeURIComponent(team)}`, `抽奖记录-${teamName(team)}.csv`);
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ---------------- 设置 ---------------- */
  $('saveWebhook').addEventListener('click', async () => {
    try {
      await api('/api/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({ webhook: $('cfgWebhook').value.trim(), secret: $('cfgSecret').value.trim() }),
      });
      toast('已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  $('testRobot').addEventListener('click', async () => {
    const btn = $('testRobot');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      const r = await api('/api/admin/dingtalk/test', { method: 'POST', body: '{}' });
      if (r.ok) toast('测试消息已发送，请查看钉钉群', 'ok');
      else toast('发送失败：' + r.message, 'err');
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = '发送测试消息'; }
  });

  $('saveWheelCfg').addEventListener('click', async () => {
    try {
      await api('/api/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          maxSegments: Number($('cfgSegments').value),
          soundOn: $('cfgSound').value === '1',
          atAll: $('cfgAtAll').value === '1',
        }),
      });
      toast('已保存，抽奖页已同步', 'ok');
      loadState();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('saveTeams').addEventListener('click', async () => {
    const cc = $('cfgTeamCc').value.trim();
    const lp = $('cfgTeamLp').value.trim();
    if (!cc || !lp) { toast('团队名称不能为空', 'err'); return; }
    try {
      await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ teams: { cc, lp } }) });
      toast('团队名称已更新', 'ok');
      loadState();
    } catch (err) { toast(err.message, 'err'); }
  });

  /* 库存日报 */
  $('saveReport').addEventListener('click', async () => {
    const time = $('cfgReportTime').value || '18:30';
    try {
      await api('/api/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({ stockReport: { on: $('cfgReportOn').value === '1', time } }),
      });
      toast(`库存日报已设置为每天 ${time} 推送`, 'ok');
      loadState();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('previewReport').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/stock-report/preview');
      const box = $('reportPreview');
      box.textContent = r.text;
      box.hidden = false;
    } catch (err) { toast(err.message, 'err'); }
  });

  $('sendReport').addEventListener('click', async () => {
    const btn = $('sendReport');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      const r = await api('/api/admin/stock-report/send', { method: 'POST', body: '{}' });
      const box = $('reportPreview');
      box.textContent = r.text || '';
      box.hidden = !r.text;
      if (r.ok) toast('库存日报已推送到钉钉群', 'ok');
      else toast('推送失败：' + r.message, 'err');
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = '立即推送一次'; }
  });

  $('pwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('cfgPwd').value;
    const b = $('cfgPwd2').value;
    if (a.length < 4) { toast('密码至少 4 位', 'err'); return; }
    if (a !== b) { toast('两次输入不一致', 'err'); return; }
    try {
      await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ password: a }) });
      $('cfgPwd').value = '';
      $('cfgPwd2').value = '';
      toast('密码已修改', 'ok');
      loadState();
    } catch (err) { toast(err.message, 'err'); }
  });

  const resetActions = {
    resetStock: { what: 'stock', title: '恢复库存', desc: '把当前团队所有礼品的剩余库存恢复为初始值，并清空「已发放」统计。' },
    resetChances: { what: 'chances', title: '重置抽奖次数', desc: '把当前团队所有抽奖人的「已抽次数」清零，让他们可以重新抽奖。' },
    resetAll: { what: 'all', title: '清空当前团队数据', desc: '将删除当前团队的礼品、抽奖人、记录，另一团队不受影响，操作不可恢复！' },
  };
  Object.keys(resetActions).forEach((id) => {
    $(id).addEventListener('click', async () => {
      const cfg = resetActions[id];
      const ok = await confirmBox(cfg.title, cfg.desc, '确认执行');
      if (!ok) return;
      try {
        await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: cfg.what, team }) });
        toast('操作完成', 'ok');
        loadState();
      } catch (err) { toast(err.message, 'err'); }
    });
  });

  /* ---------------- Tab 切换 ---------------- */
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    currentTab = btn.dataset.tab;
    [...$('tabs').children].forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('[data-panel]').forEach((sec) => {
      sec.hidden = sec.dataset.panel !== currentTab;
    });
  });

  /* ---------------- SSE ---------------- */
  let es = null;
  let refreshTimer = null;
  function connectSSE() {
    if (es) es.close();
    try {
      es = new EventSource('/api/events');
      es.addEventListener('state', () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => loadState(true), 450);
        $('liveDot').classList.remove('off');
      });
      es.onerror = () => {
        $('liveDot').classList.add('off');
        $('liveDot').lastChild.textContent = '连接中断，重连中…';
        es.close();
        setTimeout(connectSSE, 3000);
      };
      es.onopen = () => {
        $('liveDot').classList.remove('off');
        $('liveDot').lastChild.textContent = '实时同步中';
      };
    } catch (_) {}
  }

  /* ---------------- 启动 ---------------- */
  (async function init() {
    if (!token) { showLogin(); return; }
    showApp();
    await loadState();
    connectSSE();
  })();
})();

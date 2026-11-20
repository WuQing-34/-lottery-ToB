/* ============================================================
   管理后台：CC 现金抽奖（独立奖池 / 独立名单 / 概率控制）
   与 admin.js 并存，不共享其内部状态，避免互相干扰。
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'luckywheel.adminToken';
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let data = { prizes: [], participants: [], records: [], stats: {}, wheel: { segments: [], overflow: [] } };
  let cashImportMode = 'merge';
  let parsed = null;

  async function api(path, opts) {
    const o = Object.assign({}, opts);
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    if (token) o.headers['x-admin-token'] = token;
    const res = await fetch(path, o);
    let out = {};
    try { out = await res.json(); } catch (_) {}
    if (res.status === 401) { token = ''; sessionStorage.removeItem(TOKEN_KEY); throw new Error('登录已失效'); }
    if (!res.ok) throw new Error(out.message || `请求失败 (${res.status})`);
    return out;
  }

  function toast(msg, type) {
    const holder = $('toastHolder') || document.body;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    holder.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 320);
    }, 2400);
  }

  async function download(url, fallback) {
    const res = await fetch(url, { headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || '导出失败');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = star ? decodeURIComponent(star[1]) : fallback;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------------- 轻量表单弹窗（不依赖 admin.js 内部函数） ---------------- */
  function formModal(title, desc, fields) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal"><h3>' + esc(title) + '</h3>'
        + (desc ? '<p class="desc">' + esc(desc) + '</p>' : '')
        + '<div id="__cashFields">' + fields.map((f, i) => (
          '<div class="field" style="margin-bottom:12px"><label>' + esc(f.label) + '</label>'
          + '<input class="input" data-i="' + i + '" type="' + (f.type || 'text') + '" value="' + esc(f.value === undefined ? '' : f.value) + '"'
          + (f.min !== undefined ? ' min="' + f.min + '"' : '') + (f.step ? ' step="' + f.step + '"' : '')
          + ' placeholder="' + esc(f.placeholder || '') + '">'
          + (f.hint ? '<span class="hint">' + esc(f.hint) + '</span>' : '') + '</div>'
        )).join('') + '</div>'
        + '<div class="modal-actions"><button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>确定</button></div></div>';
      document.body.appendChild(mask);
      const done = (v) => { mask.remove(); resolve(v); };
      mask.querySelector('[data-no]').onclick = () => done(null);
      mask.querySelector('[data-yes]').onclick = () => {
        const out = {};
        fields.forEach((f, i) => { out[f.key] = mask.querySelector('input[data-i="' + i + '"]').value; });
        done(out);
      };
      mask.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); mask.querySelector('[data-yes]').click(); }
        if (e.key === 'Escape') done(null);
      });
      setTimeout(() => { const el = mask.querySelector('input'); if (el) { el.focus(); el.select(); } }, 50);
    });
  }

  /* ---------------- 渲染 ---------------- */
  function renderStats() {
    const s = data.stats || {};
    const cards = [
      { k: '现金奖项', v: s.prizeCount || 0 },
      { k: '可抽次数', v: s.availableWins || 0, cls: 'gold' },
      { k: '剩余库存（份）', v: s.totalStock || 0, cls: 'gold' },
      { k: '已发放（份）', v: s.totalAwarded || 0, cls: 'accent' },
      { k: '已发金额（元）', v: s.awardedAmount || 0, cls: 'accent' },
      { k: '参与人', v: s.participantCount || 0 },
      { k: '当前可抽人', v: s.readyCount || 0, cls: 'accent' },
      { k: '抽奖记录', v: s.recordCount || 0 },
    ];
    $('cashStats').innerHTML = cards.map((c) => (
      '<div class="stat ' + (c.cls || '') + '"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div></div>'
    )).join('');
    const sum = data.prizes.reduce((a, p) => a + Number(p.probability || 0), 0);
    $('cashProbSum').textContent = `设置概率合计 ${Math.round(sum * 100) / 100}% · 系统按实际占比归一化 · 抽奖页 /cash`;
  }

  function renderPrizes() {
    const list = data.prizes || [];
    $('cashPrizeEmpty').hidden = list.length > 0;
    $('cashPrizeBody').innerHTML = list.map((p) => {
      const pct = Math.min(100, Number(p.probability) || 0);
      return '<tr>'
        + '<td class="name-cell">' + esc(p.name) + '</td>'
        + '<td class="right num-cell">' + p.amount + '</td>'
        + '<td class="right num-cell"><b>' + p.stock + '</b></td>'
        + '<td class="right num-cell">' + p.perDraw + '</td>'
        + '<td class="right num-cell">' + p.remainingWins + '</td>'
        + '<td><div class="prob-bar"><i style="width:' + Math.max(2, pct) + '%"></i>'
        + '<span class="prob-num">' + p.probability + '%</span>'
        + '<span class="hint">实际 ' + (p.effectiveProbability === null ? '—' : p.effectiveProbability + '%') + '</span></div></td>'
        + '<td>' + (p.exhausted ? '<span class="tag tag-red">已发完</span>' : '<span class="tag tag-green">有货</span>') + '</td>'
        + '<td class="right"><div class="actions">'
        + '<button class="btn btn-sm" data-act="restock" data-id="' + p.id + '">补货</button>'
        + '<button class="btn btn-sm" data-act="edit" data-id="' + p.id + '">编辑</button>'
        + '<button class="btn btn-sm btn-danger" data-act="del" data-id="' + p.id + '">删除</button>'
        + '</div></td></tr>';
    }).join('');
  }

  function renderPeople() {
    const q = ($('cashPeopleSearch').value || '').trim().toLowerCase();
    const list = (data.participants || []).filter((p) => !q || String(p.name).toLowerCase().includes(q));
    $('cashPeopleCount').textContent = (data.participants || []).length + ' 人';
    $('cashPeopleEmpty').hidden = list.length > 0;
    $('cashPeopleBody').innerHTML = list.map((p) => {
      const tag = p.left > 0 ? '<span class="tag tag-green">可抽奖</span>'
        : p.used > 0 ? '<span class="tag tag-red">已抽奖</span>' : '<span class="tag tag-gray">未开始</span>';
      return '<tr><td class="name-cell">' + esc(p.name) + '</td>'
        + '<td class="right num-cell">' + p.chances + '</td>'
        + '<td class="right num-cell">' + p.used + '</td>'
        + '<td class="right num-cell"><b>' + p.left + '</b></td>'
        + '<td>' + tag + '</td>'
        + '<td class="hint">' + fmtTime(p.lastDrawnAt) + '</td>'
        + '<td class="right"><div class="actions">'
        + '<button class="btn btn-sm btn-gold" data-act="add" data-id="' + p.id + '">＋次数</button>'
        + '<button class="btn btn-sm" data-act="edit" data-id="' + p.id + '">编辑</button>'
        + '<button class="btn btn-sm btn-danger" data-act="del" data-id="' + p.id + '">删除</button>'
        + '</div></td></tr>';
    }).join('');
  }

  function renderRecords() {
    const list = data.records || [];
    $('cashRecordCount').textContent = ((data.stats || {}).recordCount || 0) + ' 条';
    $('cashRecordsEmpty').hidden = list.length > 0;
    $('cashRecordsBody').innerHTML = list.map((r, i) => {
      let push = '<span class="tag tag-gray">—</span>';
      if (r.push && r.push.status === 'ok') push = '<span class="tag tag-green">已推送</span>';
      else if (r.push && r.push.status === 'fail') push = '<span class="tag tag-red" title="' + esc(r.push.message) + '">推送失败</span>';
      else if (r.push && r.push.status === 'pending') push = '<span class="tag tag-gold">推送中</span>';
      return '<tr><td class="hint num-cell">' + (i + 1) + '</td><td class="name-cell">' + esc(r.name) + '</td>'
        + '<td><b>' + esc(r.prizeName) + '</b></td><td class="right num-cell">' + r.amount + '</td>'
        + '<td class="hint">' + fmtTime(r.time) + '</td><td>' + push + '</td></tr>';
    }).join('');
  }

  function renderAll() { renderStats(); renderPrizes(); renderPeople(); renderRecords(); }

  async function load(silent) {
    if (!token) return;
    try { data = await api('/api/admin/cash/state'); renderAll(); }
    catch (err) { if (!silent) toast(err.message, 'err'); }
  }

  /* ---------------- Excel 导入 ---------------- */
  const NAME_KEYS = ['奖项', '奖品', '名称', '现金'];
  const AMOUNT_KEYS = ['金额', '面额', '元'];
  const STOCK_KEYS = ['库存', '数量', '份数', '总数'];
  const PER_KEYS = ['每次', '发放', '单次', '每份'];
  const PROB_KEYS = ['概率', '权重', '占比'];

  function parseMatrix(matrix) {
    const norm = matrix.map((row) => (row || []).map((c) => String(c === undefined || c === null ? '' : c).trim()));
    let map = null;
    let start = 0;
    for (let i = 0; i < Math.min(norm.length, 12); i += 1) {
      const m = {};
      norm[i].forEach((cell, ci) => {
        if (!cell) return;
        if (m.name === undefined && NAME_KEYS.some((k) => cell.includes(k))) { m.name = ci; return; }
        if (m.prob === undefined && PROB_KEYS.some((k) => cell.includes(k))) { m.prob = ci; return; }
        if (m.amount === undefined && AMOUNT_KEYS.some((k) => cell.includes(k))) { m.amount = ci; return; }
        if (m.per === undefined && PER_KEYS.some((k) => cell.includes(k))) { m.per = ci; return; }
        if (m.stock === undefined && STOCK_KEYS.some((k) => cell.includes(k))) { m.stock = ci; }
      });
      if (m.name !== undefined && m.stock !== undefined) { map = m; start = i + 1; break; }
    }
    if (!map) map = { name: 0, amount: 1, stock: 2, per: 3, prob: 4 };
    const toNum = (v) => { const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
    const rows = [];
    for (let i = start; i < norm.length; i += 1) {
      const row = norm[i];
      const name = row[map.name];
      if (!name || NAME_KEYS.some((k) => name.includes(k))) continue;
      rows.push({
        name,
        amount: Math.max(0, toNum(row[map.amount])),
        stock: Math.max(0, toNum(row[map.stock])),
        perDraw: Math.max(1, toNum(row[map.per]) || 1),
        probability: Math.min(100, Math.max(0, toNum(row[map.prob]))),
      });
    }
    return rows;
  }

  function readExcel(file) {
    if (typeof XLSX === 'undefined') { toast('Excel 库未加载', 'err'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const matrix = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
        const rows = parseMatrix(matrix);
        parsed = rows.length ? rows : null;
        renderCashPreview(file.name);
      } catch (err) { parsed = null; $('cashPreviewBox').innerHTML = '<div class="warn-box">解析失败：' + esc(err.message) + '</div>'; }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderCashPreview(fileName) {
    if (!parsed) {
      $('cashPreviewBox').innerHTML = '<div class="warn-box">没有解析到有效数据，请检查表头：奖项名称 / 金额 / 库存数量 / 每次发放 / 概率</div>';
      return;
    }
    const sum = parsed.reduce((a, r) => a + r.probability, 0);
    $('cashPreviewBox').innerHTML = '<div class="between" style="margin-bottom:8px"><div><b>' + esc(fileName) + '</b> <span class="hint">解析到 ' + parsed.length + ' 个奖项</span></div>'
      + '<span class="tag tag-gold">概率合计 ' + Math.round(sum * 100) / 100 + '%</span></div>'
      + '<div class="preview-table"><table class="grid"><thead><tr><th>#</th><th>奖项</th><th class="right">金额</th><th class="right">库存</th><th class="right">概率</th></tr></thead><tbody>'
      + parsed.slice(0, 12).map((r, i) => '<tr><td class="hint num-cell">' + (i + 1) + '</td><td class="name-cell">' + esc(r.name)
        + '</td><td class="right num-cell">' + r.amount + '</td><td class="right num-cell">' + r.stock + '</td><td class="right num-cell">' + r.probability + '%</td></tr>').join('')
      + '</tbody></table></div><div class="row mt12"><button class="btn btn-primary" id="cashConfirmImport" type="button">导入（' + (cashImportMode === 'merge' ? '合并' : '覆盖') + '）</button>'
      + '<button class="btn" id="cashCancelImport" type="button">取消</button></div>';
    $('cashConfirmImport').onclick = async () => {
      const btn = $('cashConfirmImport'); btn.disabled = true;
      try {
        const r = await api('/api/admin/cash/prizes/import', { method: 'POST', body: JSON.stringify({ rows: parsed, mode: cashImportMode }) });
        toast('导入成功：新增 ' + r.created + '，更新 ' + r.updated, 'ok');
        parsed = null; $('cashPreviewBox').innerHTML = ''; load();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    };
    $('cashCancelImport').onclick = () => { parsed = null; $('cashPreviewBox').innerHTML = ''; };
  }

  /* ---------------- 事件绑定 ---------------- */
  $('cashImportMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    cashImportMode = btn.dataset.mode;
    [...$('cashImportMode').children].forEach((b) => b.classList.toggle('active', b === btn));
  });
  $('cashDropzone').addEventListener('click', () => $('cashFileInput').click());
  $('cashDropzone').addEventListener('dragover', (e) => { e.preventDefault(); $('cashDropzone').classList.add('over'); });
  $('cashDropzone').addEventListener('dragleave', () => $('cashDropzone').classList.remove('over'));
  $('cashDropzone').addEventListener('drop', (e) => {
    e.preventDefault(); $('cashDropzone').classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readExcel(f);
  });
  $('cashFileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; if (f) readExcel(f); e.target.value = '';
  });

  $('cashTplBtn').addEventListener('click', () => {
    const aoa = [
      ['奖项名称', '金额', '库存数量', '每次发放', '概率'],
      ['100元现金', 100, 3, 1, 10],
      ['50元现金', 50, 8, 1, 20],
      ['20元现金', 20, 20, 1, 30],
      ['谢谢参与', 0, 100, 1, 40],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '现金奖项');
    XLSX.writeFile(wb, '现金抽奖导入模板.xlsx');
  });

  $('cashExportInvBtn').addEventListener('click', async () => {
    try { await download('/api/admin/cash/export/inventory.xlsx', '现金抽奖库存.xlsx'); toast('已导出', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('cashExportRecords').addEventListener('click', async () => {
    try { await download('/api/admin/cash/export', '现金抽奖记录.csv'); toast('已导出', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  });

  $('cashAddPrizeBtn').addEventListener('click', async () => {
    const v = await formModal('新增现金奖项', '同名奖项会更新库存与概率', [
      { key: 'name', label: '奖项名称', placeholder: '例如：100元现金' },
      { key: 'amount', label: '金额（元）', type: 'number', value: 100, min: 0, hint: '谢谢参与填 0' },
      { key: 'stock', label: '库存数量（份）', type: 'number', value: 10, min: 0 },
      { key: 'perDraw', label: '每次发放份数', type: 'number', value: 1, min: 1 },
      { key: 'probability', label: '设置概率（%）', type: 'number', value: 10, min: 0, step: 0.01, hint: '数字越大，抽中的机会越高' },
    ]);
    if (!v) return;
    try { await api('/api/admin/cash/prizes', { method: 'POST', body: JSON.stringify(v) }); toast('已保存', 'ok'); load(); }
    catch (err) { toast(err.message, 'err'); }
  });

  $('cashPrizeBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const p = (data.prizes || []).find((x) => x.id === btn.dataset.id); if (!p) return;
    if (btn.dataset.act === 'del') {
      if (!window.confirm('确定删除「' + p.name + '」吗？历史记录会保留。')) return;
      try { await api('/api/admin/cash/prizes/' + p.id, { method: 'DELETE' }); toast('已删除', 'ok'); load(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (btn.dataset.act === 'restock') {
      const v = await formModal('补货 · ' + p.name, '当前剩余 ' + p.stock + ' 份，已发放 ' + p.awarded + ' 份', [
        { key: 'stock', label: '调整后的剩余库存（份）', type: 'number', value: p.stock, min: 0 },
      ]);
      if (!v) return;
      try { await api('/api/admin/cash/prizes/' + p.id + '/restock', { method: 'POST', body: JSON.stringify({ stock: v.stock }) }); toast('已更新', 'ok'); load(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (btn.dataset.act === 'edit') {
      const v = await formModal('编辑现金奖项', '实际概率由所有奖项的设置概率自动换算', [
        { key: 'name', label: '奖项名称', value: p.name },
        { key: 'amount', label: '金额（元）', type: 'number', value: p.amount, min: 0 },
        { key: 'stock', label: '剩余库存（份）', type: 'number', value: p.stock, min: 0 },
        { key: 'perDraw', label: '每次发放份数', type: 'number', value: p.perDraw, min: 1 },
        { key: 'probability', label: '设置概率（%）', type: 'number', value: p.probability, min: 0, step: 0.01 },
      ]);
      if (!v) return;
      try { await api('/api/admin/cash/prizes', { method: 'POST', body: JSON.stringify(Object.assign({ id: p.id }, v)) }); toast('已保存，转盘已同步', 'ok'); load(); }
      catch (err) { toast(err.message, 'err'); }
    }
  });

  $('cashAddMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]'); if (!btn) return;
    const batch = btn.dataset.mode === 'batch';
    [...$('cashAddMode').children].forEach((b) => b.classList.toggle('active', b === btn));
    $('cashSingleForm').hidden = batch;
    $('cashBatchForm').hidden = !batch;
  });

  $('cashSingleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('cashPName').value.trim();
    const chances = Number($('cashPChances').value) || 1;
    if (!name) { toast('请输入姓名', 'err'); return; }
    try {
      const r = await api('/api/admin/cash/participants', { method: 'POST', body: JSON.stringify({ name, chances }) });
      toast(r.merged ? '已追加 ' + chances + ' 次' : '已添加 ' + name, 'ok');
      $('cashPName').value = ''; $('cashPChances').value = 1; load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('cashBatchSubmit').addEventListener('click', async () => {
    const lines = $('cashBatchText').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { toast('请输入内容', 'err'); return; }
    let ok = 0; let fail = 0;
    const btn = $('cashBatchSubmit'); btn.disabled = true;
    for (const line of lines) {
      const parts = line.split(/[,，\t\s]+/).filter(Boolean);
      try {
        await api('/api/admin/cash/participants', { method: 'POST', body: JSON.stringify({ name: parts[0], chances: parts[1] ? Number(parts[1]) || 1 : 1 }) });
        ok += 1;
      } catch (_) { fail += 1; }
    }
    btn.disabled = false; $('cashBatchText').value = '';
    toast('批量完成：成功 ' + ok + (fail ? '，失败 ' + fail : ''), ok ? 'ok' : 'err'); load();
  });

  $('cashPeopleSearch').addEventListener('input', renderPeople);

  $('cashPeopleBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const p = (data.participants || []).find((x) => x.id === btn.dataset.id); if (!p) return;
    if (btn.dataset.act === 'del') {
      if (!window.confirm('删除「' + p.name + '」的现金抽奖资格？记录会保留。')) return;
      try { await api('/api/admin/cash/participants/' + p.id, { method: 'DELETE' }); toast('已删除', 'ok'); load(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (btn.dataset.act === 'add') {
      const v = await formModal('追加现金抽奖次数 · ' + p.name, '当前剩余 ' + p.left + ' 次', [
        { key: 'add', label: '追加次数', type: 'number', value: 1, min: 1 },
      ]);
      if (!v) return;
      try { await api('/api/admin/cash/participants/' + p.id, { method: 'PATCH', body: JSON.stringify({ addChances: Number(v.add) || 1 }) }); toast('已追加', 'ok'); load(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (btn.dataset.act === 'edit') {
      const v = await formModal('编辑现金抽奖人', '已抽 ' + p.used + ' 次', [
        { key: 'name', label: '姓名', value: p.name },
        { key: 'chances', label: '总次数', type: 'number', value: p.chances, min: p.used },
      ]);
      if (!v) return;
      try { await api('/api/admin/cash/participants/' + p.id, { method: 'PATCH', body: JSON.stringify(v) }); toast('已保存', 'ok'); load(); }
      catch (err) { toast(err.message, 'err'); }
    }
  });

  $('cashClearRecords').addEventListener('click', async () => {
    if (!window.confirm('清空全部现金抽奖记录？奖项与名单不受影响。')) return;
    try { await api('/api/admin/cash/reset', { method: 'POST', body: JSON.stringify({ what: 'records' }) }); toast('已清空', 'ok'); load(); }
    catch (err) { toast(err.message, 'err'); }
  });

  const resets = {
    cashResetStock: ['stock', '恢复现金库存', '把所有现金奖项的剩余库存恢复为初始值，并清空已发放统计。'],
    cashResetChances: ['chances', '重置现金次数', '把所有现金参与人的已抽次数清零。'],
    cashResetAll: ['all', '清空现金数据', '删除全部现金奖项、名单与记录，不可恢复！'],
  };
  Object.keys(resets).forEach((id) => {
    $(id).addEventListener('click', async () => {
      const cfg = resets[id];
      if (!window.confirm(cfg[1] + '：' + cfg[2] + '\n\n确定执行？')) return;
      try { await api('/api/admin/cash/reset', { method: 'POST', body: JSON.stringify({ what: cfg[0] }) }); toast('已完成', 'ok'); load(); }
      catch (err) { toast(err.message, 'err'); }
    });
  });

  /* ---------------- 登录状态变化时刷新 & 实时同步 ---------------- */
  let timer = setInterval(() => {
    const now = sessionStorage.getItem(TOKEN_KEY) || '';
    if (now !== token) { token = now; if (token) load(); }
  }, 1500);

  let es = null;
  function connect() {
    if (!token) return;
    try {
      es = new EventSource('/api/events');
      es.addEventListener('state', () => load(true));
      es.onerror = () => { es.close(); setTimeout(connect, 3000); };
    } catch (_) {}
  }

  if (token) { load(); connect(); }
})();

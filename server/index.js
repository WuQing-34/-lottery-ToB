'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const XLSX = require('xlsx');

const store = require('./store');
const lottery = require('./lottery');
const cash = require('./cash');
const dingtalk = require('./dingtalk');
const report = require('./report');
const bus = require('./bus');

const app = express();
const PORT = Number(process.env.PORT || 8082);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

/* ------------------------- 页面路由 ------------------------- */
// 两个团队各一个抽奖页，共用同一套前端，团队由路径决定
app.get(['/cc', '/lp'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'lottery.html'));
});

// CC 团队现金抽奖页：库存 / 次数 / 概率与实物完全独立
app.get(['/cash', '/cc/cash'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'cash.html'));
});

/* ------------------------- SSE 实时推送 ------------------------- */
const clients = new Set();

function broadcast(event = 'state') {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

bus.on('change', () => broadcast('state'));

/* ------------------------- 管理端鉴权 ------------------------- */
const sessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const db = store.get();
  if (String(password || '') !== String(db.config.password || '')) {
    return res.status(401).json({ ok: false, code: 'BAD_PASSWORD', message: '管理密码不正确' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  res.json({ ok: true, token, ttl: SESSION_TTL });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  sessions.delete(req.get('x-admin-token'));
  res.json({ ok: true });
});

/* ------------------------- 公共接口 ------------------------- */
app.get('/api/teams', (req, res) => {
  res.json({ ok: true, teams: lottery.teamList(), overview: lottery.overview() });
});

app.get('/api/state', (req, res) => {
  const team = String(req.query.team || 'cc');
  try {
    res.json({ ok: true, ...lottery.publicState(team), wheel: lottery.wheel(team) });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.get('/api/wheel', (req, res) => {
  const team = String(req.query.team || 'cc');
  try {
    res.json({ ok: true, ...lottery.wheel(team) });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.get('/api/me', (req, res) => {
  const team = String(req.query.team || 'cc');
  const name = String(req.query.name || '').trim();
  try {
    lottery.assertTeam(team);
  } catch (err) {
    return res.status(400).json({ ok: false, code: 'BAD_TEAM', message: err.message });
  }
  const db = store.get();
  const key = lottery.nameKey(name);
  const p = db.participants.find((x) => x.team === team && lottery.nameKey(x.name) === key);
  if (!p) return res.status(404).json({ ok: false, code: 'NOT_REGISTERED', message: '不在抽奖名单中' });
  res.json({ ok: true, participant: lottery.decorateParticipant(p) });
});

/* ------------------------- 抽奖 ------------------------- */
const drawLocks = new Map();

app.post('/api/draw', (req, res) => {
  const body = req.body || {};
  const team = String(body.team || 'cc');
  const name = String(body.name || '').trim();
  const key = team + '|' + lottery.nameKey(name);
  const now = Date.now();
  const lock = drawLocks.get(key) || 0;
  if (now - lock < 1500) {
    return res.status(429).json({ ok: false, code: 'TOO_FAST', message: '点太快啦，请稍等一秒' });
  }
  drawLocks.set(key, now);
  try {
    const result = lottery.draw(team, name);
    bus.emit('change');
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, code: err.code || 'ERROR', message: err.message });
  }
});

/* ------------------------- 现金抽奖（CC 专属） ------------------------- */
app.get('/api/cash/state', (req, res) => {
  try { res.json(cash.publicState()); }
  catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.get('/api/cash/wheel', (req, res) => {
  try { res.json({ ok: true, ...cash.wheel() }); }
  catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.get('/api/cash/me', (req, res) => {
  const name = String(req.query.name || '').trim();
  const p = (store.get().cashParticipants || []).find((x) => lottery.nameKey(x.name) === lottery.nameKey(name));
  if (!p) return res.status(404).json({ ok: false, code: 'NOT_REGISTERED', message: '不在现金抽奖名单中' });
  res.json({ ok: true, participant: cash.decoratePerson(p) });
});

const cashLocks = new Map();
app.post('/api/cash/draw', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const key = 'cash|' + lottery.nameKey(name);
  const now = Date.now();
  if (now - (cashLocks.get(key) || 0) < 1500) {
    return res.status(429).json({ ok: false, code: 'TOO_FAST', message: '点太快啦，请稍等一秒' });
  }
  cashLocks.set(key, now);
  try {
    const result = cash.draw(name);
    bus.emit('change');
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, code: err.code || 'ERROR', message: err.message });
  }
});

/* ------------------------- 管理：总览 / 库存 ------------------------- */
app.get('/api/admin/state', requireAdmin, (req, res) => {
  const db = store.get();
  const team = String(req.query.team || 'cc');
  try {
    res.json({
      ok: true,
      ...lottery.publicState(team),
      wheel: lottery.wheel(team),
      config: {
        soundOn: !!db.config.soundOn,
        maxSegments: db.config.maxSegments,
        atAll: !!db.config.atAll,
        webhook: db.config.webhook || '',
        secret: db.config.secret || '',
        teams: db.config.teams,
        stockReport: db.config.stockReport,
        passwordIsDefault: db.config.password === 'CHANGE_ME_2026',
      },
    });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.post('/api/admin/prizes', requireAdmin, (req, res) => {
  try {
    const prize = lottery.upsertPrize(req.body || {});
    bus.emit('change');
    res.json({ ok: true, prize });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.post('/api/admin/prizes/import', requireAdmin, (req, res) => {
  try {
    const { rows, mode, team } = req.body || {};
    const result = lottery.importPrizes(rows, mode === 'replace' ? 'replace' : 'merge', team);
    bus.emit('change');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.post('/api/admin/prizes/:id/restock', requireAdmin, (req, res) => {
  try {
    const prize = lottery.restockPrize(req.params.id, req.body && req.body.stock);
    bus.emit('change');
    res.json({ ok: true, prize });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.delete('/api/admin/prizes/:id', requireAdmin, (req, res) => {
  try {
    lottery.deletePrize(req.params.id);
    bus.emit('change');
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

/* ------------------------- 管理：抽奖人 ------------------------- */
app.post('/api/admin/participants', requireAdmin, (req, res) => {
  try {
    const result = lottery.addParticipant(req.body || {});
    bus.emit('change');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.patch('/api/admin/participants/:id', requireAdmin, (req, res) => {
  try {
    const participant = lottery.updateParticipant(req.params.id, req.body || {});
    bus.emit('change');
    res.json({ ok: true, participant });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.delete('/api/admin/participants/:id', requireAdmin, (req, res) => {
  try {
    lottery.deleteParticipant(req.params.id);
    bus.emit('change');
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

/* ------------------------- 管理：现金抽奖（CC 专属） ------------------------- */
app.get('/api/admin/cash/state', requireAdmin, (req, res) => {
  try { res.json(cash.publicState()); }
  catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.post('/api/admin/cash/prizes', requireAdmin, (req, res) => {
  try {
    const prize = cash.upsertPrize(req.body || {});
    bus.emit('change');
    res.json({ ok: true, prize });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.post('/api/admin/cash/prizes/import', requireAdmin, (req, res) => {
  try {
    const { rows, mode } = req.body || {};
    const result = cash.importPrizes(rows, mode === 'replace' ? 'replace' : 'merge');
    bus.emit('change');
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.post('/api/admin/cash/prizes/:id/restock', requireAdmin, (req, res) => {
  try {
    const prize = cash.restockPrize(req.params.id, req.body && req.body.stock);
    bus.emit('change');
    res.json({ ok: true, prize });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.delete('/api/admin/cash/prizes/:id', requireAdmin, (req, res) => {
  try {
    cash.deletePrize(req.params.id);
    bus.emit('change');
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.post('/api/admin/cash/participants', requireAdmin, (req, res) => {
  try {
    const result = cash.addParticipant(req.body || {});
    bus.emit('change');
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.patch('/api/admin/cash/participants/:id', requireAdmin, (req, res) => {
  try {
    const participant = cash.updateParticipant(req.params.id, req.body || {});
    bus.emit('change');
    res.json({ ok: true, participant });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.delete('/api/admin/cash/participants/:id', requireAdmin, (req, res) => {
  try {
    cash.deleteParticipant(req.params.id);
    bus.emit('change');
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

app.post('/api/admin/cash/reset', requireAdmin, (req, res) => {
  try {
    cash.reset(String((req.body || {}).what || ''));
    bus.emit('change');
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 400).json({ ok: false, message: err.message }); }
});

/* ------------------------- 管理：重置 / 配置 ------------------------- */
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    lottery.reset(String(body.what || ''), String(body.team || 'all'));
    bus.emit('change');
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, message: err.message });
  }
});

app.patch('/api/admin/config', requireAdmin, (req, res) => {
  const db = store.get();
  const body = req.body || {};
  if (body.password !== undefined) {
    if (String(body.password).length < 4) return res.status(400).json({ ok: false, message: '密码至少 4 位' });
    db.config.password = String(body.password);
  }
  if (body.webhook !== undefined) db.config.webhook = String(body.webhook).trim();
  if (body.secret !== undefined) db.config.secret = String(body.secret).trim();
  if (body.soundOn !== undefined) db.config.soundOn = !!body.soundOn;
  if (body.atAll !== undefined) db.config.atAll = !!body.atAll;
  if (body.maxSegments !== undefined) db.config.maxSegments = Math.min(12, Math.max(4, Number(body.maxSegments) || 12));
  if (body.teams && typeof body.teams === 'object') {
    lottery.TEAM_IDS.forEach((id) => {
      if (body.teams[id]) db.config.teams[id] = String(body.teams[id]).slice(0, 20);
    });
  }
  if (body.stockReport && typeof body.stockReport === 'object') {
    const sr = db.config.stockReport || (db.config.stockReport = {});
    if (body.stockReport.on !== undefined) sr.on = !!body.stockReport.on;
    if (body.stockReport.time !== undefined && /^\d{1,2}:\d{2}$/.test(String(body.stockReport.time))) {
      sr.time = String(body.stockReport.time);
    }
  }
  store.save();
  store.addLog('config', '更新系统配置');
  bus.emit('change');
  res.json({ ok: true, config: { ...db.config, password: undefined } });
});

app.post('/api/admin/dingtalk/test', requireAdmin, async (req, res) => {
  const result = await dingtalk.test();
  store.addLog('dingtalk', result.ok ? '机器人测试成功' : `机器人测试失败：${result.message}`);
  res.json({ ok: result.ok, message: result.message });
});

/* ------------------------- 库存日报 ------------------------- */
app.get('/api/admin/stock-report/preview', requireAdmin, (req, res) => {
  res.json({ ok: true, text: report.buildStockReport(), now: report.nowInShanghai() });
});

app.post('/api/admin/stock-report/send', requireAdmin, async (req, res) => {
  try {
    const r = await report.sendStockReport('手动');
    bus.emit('change');
    res.json({ ok: r.ok, message: r.message, text: r.text });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/* ------------------------- 导出 ------------------------- */
// 库存导出（真正的 Excel 文件）
app.get('/api/admin/export/inventory.xlsx', requireAdmin, (req, res) => {
  const team = String(req.query.team || 'all');
  try {
    lottery.assertTeam(team, true);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  const db = store.get();
  const teams = team === 'all' ? lottery.TEAM_IDS : [team];
  const wb = XLSX.utils.book_new();

  const priStatus = (p) => {
    const wins = lottery.remainingWins(p);
    if (Number(p.stock) <= 0) return '已发完';
    if (wins <= 0) return '不足一份';
    if (wins <= 2) return '库存紧张';
    return '有货';
  };

  if (team === 'all') {
    const head = [['团队', '礼品种类', '剩余库存(件)', '已发放(件)', '剩余可抽次数', '抽奖人数', '当前可抽奖', '抽奖记录数']];
    lottery.TEAM_IDS.forEach((id) => {
      const s = lottery.stats(id);
      head.push([lottery.teamName(id), s.prizeCount, s.totalStock, s.totalAwarded, s.availableWins, s.participantCount, s.readyCount, s.recordCount]);
    });
    const ws = XLSX.utils.aoa_to_sheet(head);
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, '团队汇总');
  }

  teams.forEach((id) => {
    const prizes = lottery.scope(db.prizes, id);
    const probs = lottery.effectiveProbabilities(prizes);
    const rows = [[
      '序号', '礼品名称', '初始库存', '已发放', '剩余库存', '每次发放数量', '剩余可抽次数', '设置概率(%)', '实际概率(%)', '状态', '最近更新',
    ]];
    prizes
      .forEach((p, i) => {
        rows.push([
          i + 1,
          p.name,
          Number(p.initial) || 0,
          Number(p.awarded) || 0,
          Number(p.stock) || 0,
          Number(p.perDraw) || 1,
          lottery.remainingWins(p),
          Number(p.probability) || 0,
          probs[p.id] === undefined ? '' : probs[p.id],
          priStatus(p),
          p.updatedAt ? new Date(p.updatedAt).toLocaleString('zh-CN') : '',
        ]);
      });
    if (rows.length === 1) rows.push(['', '（该团队暂无礼品）', '', '', '', '', '', '', '', '', '']);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 6 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }];
    const sheetName = (lottery.teamName(id).replace(/[[\]:*?/\\]/g, '') || id).slice(0, 28);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const name = `库存表-${team === 'all' ? '全部团队' : lottery.teamName(team)}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="inventory.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buf);
});

// 现金抽奖库存导出（Excel，含实际概率）
app.get('/api/admin/cash/export/inventory.xlsx', requireAdmin, (req, res) => {
  const db = store.get();
  const rows = [['序号', '奖项名称', '金额(元)', '初始库存(份)', '已发放(份)', '剩余库存(份)', '每次发放', '剩余可抽次数', '设置概率(%)', '实际概率(%)', '状态', '最近更新']];
  (db.cashPrizes || []).forEach((p, i) => {
    const d = cash.decorate(p, cash.effectiveProbabilities(db.cashPrizes));
    rows.push([
      i + 1, p.name, d.amount, d.initial, d.awarded, d.stock, d.perDraw, d.remainingWins,
      d.probability, d.effectiveProbability === null ? '' : d.effectiveProbability,
      d.exhausted ? '已发完' : '有货',
      d.updatedAt ? new Date(d.updatedAt).toLocaleString('zh-CN') : '',
    ]);
  });
  if (rows.length === 1) rows.push(['', '（暂无现金奖项）', '', '', '', '', '', '', '', '', '', '']);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 22 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '现金抽奖库存');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const name = `现金抽奖库存-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="cash-inventory.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buf);
});

// 现金抽奖记录导出（CSV）
app.get('/api/admin/cash/export', requireAdmin, (req, res) => {
  const rows = [['姓名', '抽中奖项', '发放份数', '抽奖时间', '钉钉推送']];
  (store.get().cashRecords || []).forEach((r) => {
    rows.push([
      r.name, r.prizeName, r.amount,
      new Date(r.time).toLocaleString('zh-CN'),
      r.push && r.push.status === 'ok' ? '成功' : '失败/待推送',
    ]);
  });
  const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c === undefined ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cash-records.csv"; filename*=UTF-8''${encodeURIComponent('现金抽奖记录.csv')}`);
  res.send(csv);
});

// 抽奖记录导出（CSV）
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const team = String(req.query.team || 'all');
  try {
    lottery.assertTeam(team, true);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  const db = store.get();
  const rows = [['团队', '姓名', '奖品', '发放数量', '抽奖时间', '推送状态']];
  lottery.scope(db.records, team).forEach((r) => {
    rows.push([
      lottery.teamName(r.team),
      r.name,
      r.prizeName,
      r.amount,
      new Date(r.time).toLocaleString('zh-CN'),
      r.push && r.push.status === 'ok' ? '成功' : '失败/待推送',
    ]);
  });
  const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c === undefined ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="records.csv"; filename*=UTF-8''${encodeURIComponent('抽奖记录.csv')}`);
  res.send(csv);
});

/* ------------------------- 兜底 ------------------------- */
app.use('/api', (req, res) => res.status(404).json({ ok: false, message: '接口不存在' }));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: err.message || '服务器内部错误' });
});

store.get();
app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🎡 抽奖系统已启动');
  console.log(`  ├─ 团队入口    http://localhost:${PORT}/`);
  console.log(`  ├─ CC 抽奖页   http://localhost:${PORT}/cc`);
  console.log(`  ├─ LP 抽奖页   http://localhost:${PORT}/lp`);
  console.log(`  ├─ CC 现金抽奖 http://localhost:${PORT}/cash`);
  console.log(`  ├─ 管理后台    http://localhost:${PORT}/admin`);
  console.log(`  └─ 数据文件    ${store.DATA_FILE}`);
  console.log('');
  report.start();
});

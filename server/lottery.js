'use strict';

const store = require('./store');
const dingtalk = require('./dingtalk');
const bus = require('./bus');

const MAX_RECORDS = 2000;
const TEAM_IDS = store.TEAM_IDS;

function num(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : def;
}

function httpError(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}
const badRequest = (m) => httpError('BAD_REQUEST', m, 400);
const notFound = (m) => httpError('NOT_FOUND', m, 404);

/** 校验团队；'all' 仅用于查询/导出 */
function assertTeam(team, allowAll) {
  if (allowAll && team === 'all') return 'all';
  if (!TEAM_IDS.includes(team)) throw badRequest('团队参数不正确（应为 cc 或 lp）');
  return team;
}

function teamName(id) {
  const cfg = store.get().config.teams || {};
  return cfg[id] || id.toUpperCase();
}

function nameKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 按团队过滤 */
function scope(list, team) {
  if (team === 'all') return list;
  return list.filter((x) => x.team === team);
}

/** 剩余可发放次数 = 剩余库存 / 每次发放数量 */
function remainingWins(prize) {
  const per = Math.max(1, num(prize.perDraw, 1));
  return Math.max(0, Math.floor(num(prize.stock, 0) / per));
}

function decoratePrize(p) {
  const per = Math.max(1, num(p.perDraw, 1));
  return {
    id: p.id,
    team: p.team,
    name: p.name,
    stock: num(p.stock, 0),
    perDraw: per,
    initial: num(p.initial, 0),
    awarded: num(p.awarded, 0),
    remainingWins: remainingWins(p),
    exhausted: num(p.stock, 0) < per,
    updatedAt: p.updatedAt || p.createdAt || null,
  };
}

function decorateParticipant(p) {
  const chances = num(p.chances, 0);
  const used = num(p.used, 0);
  const left = Math.max(0, chances - used);
  return {
    id: p.id,
    team: p.team,
    name: p.name,
    chances,
    used,
    left,
    status: left > 0 ? 'ready' : used > 0 ? 'done' : 'idle',
    createdAt: p.createdAt || null,
    lastDrawnAt: p.lastDrawnAt || null,
  };
}

/** 当前上转盘的奖品：该团队有货 + 不超过转盘格子数 */
function wheelPrizes(team) {
  const db = store.get();
  const cap = Math.min(12, Math.max(4, num(db.config.maxSegments, 12)));
  const all = scope(db.prizes, team)
    .filter((p) => remainingWins(p) > 0)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { cap, onWheel: all.slice(0, cap), overflow: all.slice(cap) };
}

function wheel(team) {
  const { cap, onWheel, overflow } = wheelPrizes(team);
  return {
    team,
    teamName: teamName(team),
    cap,
    segments: onWheel.map((p) => ({ id: p.id, name: p.name, perDraw: num(p.perDraw, 1) })),
    overflow: overflow.map((p) => p.name),
  };
}

function stats(team) {
  const db = store.get();
  const prizes = scope(db.prizes, team);
  const people = scope(db.participants, team);
  const recs = scope(db.records, team);
  return {
    team,
    teamName: teamName(team),
    prizeCount: prizes.length,
    totalStock: prizes.reduce((s, p) => s + num(p.stock, 0), 0),
    totalAwarded: prizes.reduce((s, p) => s + num(p.awarded, 0), 0),
    availableWins: prizes.reduce((s, p) => s + remainingWins(p), 0),
    participantCount: people.length,
    readyCount: people.filter((p) => num(p.chances, 0) - num(p.used, 0) > 0).length,
    recordCount: recs.length,
  };
}

function teamList() {
  const cfg = store.get().config.teams || {};
  return TEAM_IDS.map((id) => ({ id, name: cfg[id] || id.toUpperCase() }));
}

function overview() {
  return TEAM_IDS.map((id) => ({
    id,
    name: teamName(id),
    ...stats(id),
  }));
}

function publicState(team) {
  const db = store.get();
  const t = assertTeam(team, true);
  return {
    team: t,
    teams: teamList(),
    prizes: scope(db.prizes, t).map(decoratePrize),
    participants: scope(db.participants, t).map(decorateParticipant),
    records: scope(db.records, t).slice(0, 100),
    logs: db.logs.slice(0, 60),
    stats: stats(t),
    overview: overview(),
    config: {
      soundOn: !!db.config.soundOn,
      maxSegments: db.config.maxSegments,
      passwordIsDefault: db.config.password === 'CHANGE_ME_2026',
    },
  };
}

/* ---------------- 奖品 ---------------- */

function upsertPrize({ id, team, name, stock, perDraw }) {
  const db = store.get();
  const t = assertTeam(team);
  const cleanName = String(name || '').trim();
  if (!cleanName) throw badRequest('礼品名称不能为空');
  const s = Math.max(0, Math.floor(num(stock, 0)));
  const per = Math.max(1, Math.floor(num(perDraw, 1)));

  let prize = id
    ? db.prizes.find((p) => p.id === id)
    : db.prizes.find((p) => p.team === t && nameKey(p.name) === nameKey(cleanName));

  if (prize) {
    prize.team = t;
    prize.name = cleanName;
    prize.stock = s;
    prize.perDraw = per;
    prize.initial = s + num(prize.awarded, 0);
    prize.updatedAt = new Date().toISOString();
  } else {
    prize = {
      id: store.uid('pz'),
      team: t,
      name: cleanName,
      stock: s,
      perDraw: per,
      initial: s,
      awarded: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.prizes.push(prize);
  }
  store.save();
  return decoratePrize(prize);
}

/**
 * Excel 导入
 * rows: [{ name, stock, perDraw }]
 * mode: 'merge' 合并（同名更新库存） | 'replace' 覆盖（清空该团队后重建）
 */
function importPrizes(rows, mode, team) {
  const db = store.get();
  const t = assertTeam(team);
  const list = (Array.isArray(rows) ? rows : []).filter((r) => String((r && r.name) || '').trim());
  if (!list.length) throw badRequest('没有解析到有效数据，请检查表格表头是否为：礼品名称 / 库存数量 / 每次发放数量');

  if (mode === 'replace') {
    db.prizes = db.prizes.filter((p) => p.team !== t);
  }
  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();
  list.forEach((r) => {
    const cleanName = String(r.name).trim();
    const s = Math.max(0, Math.floor(num(r.stock, 0)));
    const per = Math.max(1, Math.floor(num(r.perDraw, 1)));
    let prize = db.prizes.find((p) => p.team === t && nameKey(p.name) === nameKey(cleanName));
    if (prize) {
      prize.stock = s;
      prize.perDraw = per;
      prize.initial = s + num(prize.awarded, 0);
      prize.updatedAt = now;
      updated += 1;
    } else {
      db.prizes.push({
        id: store.uid('pz'), team: t, name: cleanName, stock: s, perDraw: per,
        initial: s, awarded: 0, createdAt: now, updatedAt: now,
      });
      created += 1;
    }
  });
  store.save();
  store.addLog('import', `[${teamName(t)}] Excel 导入：新增 ${created}，更新 ${updated}${mode === 'replace' ? '（覆盖模式）' : ''}`);
  return { created, updated, total: db.prizes.filter((p) => p.team === t).length };
}

function deletePrize(id) {
  const db = store.get();
  const idx = db.prizes.findIndex((p) => p.id === id);
  if (idx < 0) throw notFound('礼品不存在');
  const [removed] = db.prizes.splice(idx, 1);
  store.save();
  store.addLog('prize', `[${teamName(removed.team)}] 删除礼品：${removed.name}`);
  return { ok: true };
}

function restockPrize(id, stock) {
  const db = store.get();
  const prize = db.prizes.find((p) => p.id === id);
  if (!prize) throw notFound('礼品不存在');
  prize.stock = Math.max(0, Math.floor(num(stock, 0)));
  prize.initial = prize.stock + num(prize.awarded, 0);
  prize.updatedAt = new Date().toISOString();
  store.save();
  store.addLog('prize', `[${teamName(prize.team)}] 调整库存：${prize.name} → ${prize.stock}`);
  return decoratePrize(prize);
}

/* ---------------- 抽奖人 ---------------- */

function addParticipant({ name, chances, team }) {
  const db = store.get();
  const t = assertTeam(team);
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
  if (!cleanName) throw badRequest('姓名不能为空');
  const add = Math.floor(num(chances, 1));
  if (add <= 0) throw badRequest('抽奖次数必须大于 0');

  let p = db.participants.find((x) => x.team === t && nameKey(x.name) === nameKey(cleanName));
  let merged = false;
  if (p) {
    p.name = cleanName;
    p.chances = num(p.chances, 0) + add;
    merged = true;
  } else {
    p = {
      id: store.uid('pp'),
      team: t,
      name: cleanName,
      chances: add,
      used: 0,
      createdAt: new Date().toISOString(),
      lastDrawnAt: null,
    };
    db.participants.push(p);
  }
  store.save();
  store.addLog(
    'participant',
    merged
      ? `[${teamName(t)}] 追加抽奖次数：${cleanName} +${add}`
      : `[${teamName(t)}] 新增抽奖人：${cleanName}（${add} 次）`,
  );
  return { participant: decorateParticipant(p), merged };
}

function updateParticipant(id, patch) {
  const db = store.get();
  const p = db.participants.find((x) => x.id === id);
  if (!p) throw notFound('抽奖人不存在');
  if (patch.name !== undefined) {
    const cleanName = String(patch.name).trim().replace(/\s+/g, ' ');
    if (!cleanName) throw badRequest('姓名不能为空');
    p.name = cleanName;
  }
  if (patch.chances !== undefined) p.chances = Math.max(num(p.used, 0), Math.floor(num(patch.chances, 0)));
  if (patch.addChances !== undefined) p.chances = num(p.chances, 0) + Math.floor(num(patch.addChances, 0));
  if (patch.used !== undefined) p.used = Math.max(0, Math.floor(num(patch.used, 0)));
  store.save();
  return decorateParticipant(p);
}

function deleteParticipant(id) {
  const db = store.get();
  const idx = db.participants.findIndex((x) => x.id === id);
  if (idx < 0) throw notFound('抽奖人不存在');
  const [removed] = db.participants.splice(idx, 1);
  store.save();
  store.addLog('participant', `[${teamName(removed.team)}] 删除抽奖人：${removed.name}`);
  return { ok: true };
}

/* ---------------- 抽奖 ---------------- */

function draw(team, rawName) {
  const db = store.get();
  const t = assertTeam(team);
  const label = teamName(t);
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (!name) throw httpError('NAME_REQUIRED', '请输入姓名', 400);

  const person = db.participants.find((x) => x.team === t && nameKey(x.name) === nameKey(name));
  if (!person) throw httpError('NOT_REGISTERED', `「${name}」不在${label}的抽奖名单中，请联系管理员添加`, 403);

  const left = num(person.chances, 0) - num(person.used, 0);
  if (left <= 0) {
    throw httpError('NO_CHANCE', `「${person.name}」的抽奖次数已用完，请等待管理员添加新的抽奖次数`, 403);
  }

  const { onWheel, overflow } = wheelPrizes(t);
  if (overflow.length) {
    console.warn('[draw] 有奖品未上转盘:', overflow.map((p) => p.name).join(', '));
  }
  if (!onWheel.length) throw httpError('NO_STOCK', '奖品库存已发完，请联系管理员补充', 409);

  // 按「可发放次数」加权，保证各奖项被抽中的机会与其库存量成正比
  const weights = onWheel.map((p) => remainingWins(p));
  const totalW = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalW;
  let index = 0;
  for (let i = 0; i < onWheel.length; i += 1) {
    r -= weights[i];
    if (r <= 0) {
      index = i;
      break;
    }
    index = i;
  }

  const prize = onWheel[index];
  const per = Math.max(1, num(prize.perDraw, 1));

  prize.stock = Math.max(0, num(prize.stock, 0) - per);
  prize.awarded = num(prize.awarded, 0) + per;
  prize.updatedAt = new Date().toISOString();

  person.used = num(person.used, 0) + 1;
  person.lastDrawnAt = new Date().toISOString();

  const record = {
    id: store.uid('rc'),
    team: t,
    name: person.name,
    prizeId: prize.id,
    prizeName: prize.name,
    amount: per,
    time: new Date().toISOString(),
    push: { status: 'pending', message: '' },
  };
  db.records.unshift(record);
  if (db.records.length > MAX_RECORDS) db.records.length = MAX_RECORDS;
  store.save();

  // 钉钉文案：[姓名]抽中[奖品][数量]份
  const text = `${person.name}抽中${prize.name}${per}份`;

  dingtalk.sendText(text)
    .then((res) => {
      record.push = { status: res.ok ? 'ok' : 'fail', message: res.message || '' };
      store.save();
      if (!res.ok) store.addLog('dingtalk', `推送失败：${res.message}`);
      bus.emit('change');
    })
    .catch((err) => {
      record.push = { status: 'fail', message: err.message };
      store.save();
      store.addLog('dingtalk', `推送异常：${err.message}`);
      bus.emit('change');
    });

  return {
    ok: true,
    team: t,
    record: { id: record.id, name: record.name, prizeName: record.prizeName, amount: record.amount, time: record.time },
    text,
    index,
    segmentCount: onWheel.length,
    remaining: Math.max(0, person.chances - person.used),
    used: person.used,
    chances: person.chances,
    prize: decoratePrize(prize),
    stats: stats(t),
  };
}

function reset(what, team) {
  const db = store.get();
  const t = assertTeam(team, true);
  const match = (x) => t === 'all' || x.team === t;

  if (what === 'records' || what === 'all') {
    db.records = db.records.filter((r) => !match(r));
  }
  if (what === 'all') {
    db.prizes = db.prizes.filter((p) => !match(p));
    db.participants = db.participants.filter((p) => !match(p));
    if (t === 'all') db.logs = [];
  }
  if (what === 'stock') {
    db.prizes.filter(match).forEach((p) => {
      p.stock = num(p.initial, 0);
      p.awarded = 0;
    });
  }
  if (what === 'chances') {
    db.participants.filter(match).forEach((p) => {
      p.used = 0;
    });
  }
  store.save();
  store.addLog('reset', `[${t === 'all' ? '全部团队' : teamName(t)}] 重置操作：${what}`);
  return { ok: true };
}

module.exports = {
  TEAM_IDS,
  teamList,
  teamName,
  overview,
  assertTeam,
  publicState,
  wheel,
  draw,
  upsertPrize,
  importPrizes,
  deletePrize,
  restockPrize,
  addParticipant,
  updateParticipant,
  deleteParticipant,
  reset,
  stats,
  scope,
  decoratePrize,
  decorateParticipant,
  remainingWins,
  nameKey,
};

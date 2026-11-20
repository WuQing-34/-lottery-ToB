'use strict';

/**
 * CC 团队 · 现金抽奖模块
 * 与实物抽奖完全隔离：独立的库存、名单、次数、记录、概率配置。
 */

const store = require('./store');
const dingtalk = require('./dingtalk');
const bus = require('./bus');
const { nameKey, teamName } = require('./lottery');

const MAX_RECORDS = 2000;
const MAX_SEGMENTS = 12;

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

function remainingWins(p) {
  return Math.max(0, Math.floor(Math.max(0, num(p.stock, 0)) / Math.max(1, num(p.perDraw, 1))));
}

/** 各奖项实际生效概率（%）：按可抽奖品的 probability 归一化；未填则均分 */
function effectiveProbabilities(prizes) {
  const active = prizes.filter((p) => remainingWins(p) > 0);
  const raw = active.map((p) => Math.max(0, num(p.probability, 0)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const out = {};
  active.forEach((p, i) => {
    out[p.id] = sum > 0 ? Math.round((raw[i] / sum) * 10000) / 100 : Math.round((100 / active.length) * 100) / 100;
  });
  return out;
}

function decorate(p, probs) {
  const prob = probs ? probs[p.id] : undefined;
  return {
    id: p.id,
    name: p.name,
    amount: num(p.amount, 0),
    stock: num(p.stock, 0),
    perDraw: Math.max(1, num(p.perDraw, 1)),
    probability: Math.max(0, num(p.probability, 0)),
    effectiveProbability: prob === undefined ? null : prob,
    initial: num(p.initial, 0),
    awarded: num(p.awarded, 0),
    remainingWins: remainingWins(p),
    exhausted: remainingWins(p) <= 0,
    updatedAt: p.updatedAt || p.createdAt || null,
  };
}

function decoratePerson(p) {
  const chances = num(p.chances, 0);
  const used = num(p.used, 0);
  const left = Math.max(0, chances - used);
  return {
    id: p.id,
    name: p.name,
    chances,
    used,
    left,
    status: left > 0 ? 'ready' : used > 0 ? 'done' : 'idle',
    createdAt: p.createdAt || null,
    lastDrawnAt: p.lastDrawnAt || null,
  };
}

function stats() {
  const db = store.get();
  const prizes = db.cashPrizes || [];
  const people = db.cashParticipants || [];
  return {
    prizeCount: prizes.length,
    totalStock: prizes.reduce((s, p) => s + num(p.stock, 0), 0),
    totalAwarded: prizes.reduce((s, p) => s + num(p.awarded, 0), 0),
    awardedAmount: prizes.reduce((s, p) => s + num(p.amount, 0) * num(p.awarded, 0), 0),
    availableWins: prizes.reduce((s, p) => s + remainingWins(p), 0),
    participantCount: people.length,
    readyCount: people.filter((p) => num(p.chances, 0) - num(p.used, 0) > 0).length,
    recordCount: (db.cashRecords || []).length,
  };
}

function wheel() {
  const db = store.get();
  const cap = Math.min(MAX_SEGMENTS, Math.max(4, num(db.config.maxSegments, 12)));
  const all = (db.cashPrizes || [])
    .filter((p) => remainingWins(p) > 0)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const probs = effectiveProbabilities(all);
  return {
    cap,
      // 扇区面积一律等分，不下发 weight；中奖概率由 pickByProbability 按 probability 独立决定
      segments: all.slice(0, cap).map((p) => ({
        id: p.id,
        name: p.name,
        amount: num(p.amount, 0),
        probability: probs[p.id],
      })),
    overflow: all.slice(cap).map((p) => p.name),
    probabilitySum: Math.round(all.reduce((s, p) => s + Math.max(0, num(p.probability, 0)), 0) * 100) / 100,
  };
}

function publicState() {
  const db = store.get();
  const probs = effectiveProbabilities(db.cashPrizes || []);
  return {
    ok: true,
    prizes: (db.cashPrizes || []).map((p) => decorate(p, probs)),
    participants: (db.cashParticipants || []).map(decoratePerson),
    records: (db.cashRecords || []).slice(0, 100),
    stats: stats(),
    wheel: wheel(),
    probabilitySum: Math.round((db.cashPrizes || []).reduce((s, p) => s + Math.max(0, num(p.probability, 0)), 0) * 100) / 100,
    config: { soundOn: !!db.config.soundOn, maxSegments: wheel().cap },
    teamName: teamName('cc'),
  };
}

/* ---------------- 概率抽取（可注入随机源，便于测试） ---------------- */
function pickByProbability(list, rand) {
  const active = list.filter((p) => remainingWins(p) > 0);
  if (!active.length) return -1;
  const weights = active.map((p) => Math.max(0, num(p.probability, 0)));
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    weights.fill(1);
    total = active.length;
  }
  let r = (typeof rand === 'function' ? rand() : Math.random()) * total;
  for (let i = 0; i < active.length; i += 1) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return active.length - 1;
}

/* ---------------- 奖项 CRUD ---------------- */
function upsertPrize(body = {}) {
  const db = store.get();
  const cleanName = String(body.name || '').trim();
  if (!cleanName) throw badRequest('奖项名称不能为空');
  const amount = Math.max(0, Math.floor(num(body.amount, 0)));
  const stock = Math.max(0, Math.floor(num(body.stock, 0)));
  const per = Math.max(1, Math.floor(num(body.perDraw, 1)));
  const prob = Math.min(100, Math.max(0, num(body.probability, 0)));

  let prize = body.id
    ? db.cashPrizes.find((p) => p.id === body.id)
    : db.cashPrizes.find((p) => nameKey(p.name) === nameKey(cleanName));
  if (prize) {
    prize.name = cleanName;
    prize.amount = amount;
    prize.stock = stock;
    prize.perDraw = per;
    prize.probability = prob;
    prize.initial = stock + num(prize.awarded, 0);
    prize.updatedAt = new Date().toISOString();
  } else {
    prize = {
      id: store.uid('cs'),
      name: cleanName,
      amount,
      stock,
      perDraw: per,
      probability: prob,
      initial: stock,
      awarded: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.cashPrizes.push(prize);
  }
  store.save();
  store.addLog('cash', `现金奖项保存：${prize.name}（概率 ${prob}%）`);
  return decorate(prize, effectiveProbabilities(db.cashPrizes));
}

function importPrizes(rows, mode = 'merge') {
  const db = store.get();
  const list = (Array.isArray(rows) ? rows : []).filter((r) => String((r && r.name) || '').trim());
  if (!list.length) throw badRequest('没有解析到有效数据，表头应为：奖项名称 / 金额 / 库存数量 / 每次发放 / 概率');
  if (mode === 'replace') db.cashPrizes = [];

  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();
  list.forEach((r) => {
    const name = String(r.name).trim();
    const amount = Math.max(0, Math.floor(num(r.amount, 0)));
    const stock = Math.max(0, Math.floor(num(r.stock, 0)));
    const per = Math.max(1, Math.floor(num(r.perDraw, 1)));
    const prob = Math.min(100, Math.max(0, num(r.probability, 0)));
    let prize = db.cashPrizes.find((p) => nameKey(p.name) === nameKey(name));
    if (prize) {
      prize.amount = amount;
      prize.stock = stock;
      prize.perDraw = per;
      prize.probability = prob;
      prize.initial = stock + num(prize.awarded, 0);
      prize.updatedAt = now;
      updated += 1;
    } else {
      db.cashPrizes.push({
        id: store.uid('cs'), name, amount, stock, perDraw: per, probability: prob,
        initial: stock, awarded: 0, createdAt: now, updatedAt: now,
      });
      created += 1;
    }
  });
  store.save();
  store.addLog('cash', `现金奖项 Excel 导入：新增 ${created}，更新 ${updated}${mode === 'replace' ? '（覆盖）' : ''}`);
  return { created, updated, total: db.cashPrizes.length };
}

function deletePrize(id) {
  const db = store.get();
  const idx = db.cashPrizes.findIndex((p) => p.id === id);
  if (idx < 0) throw notFound('现金奖项不存在');
  const [removed] = db.cashPrizes.splice(idx, 1);
  store.save();
  store.addLog('cash', `删除现金奖项：${removed.name}`);
  return { ok: true };
}

function restockPrize(id, stock) {
  const db = store.get();
  const prize = db.cashPrizes.find((p) => p.id === id);
  if (!prize) throw notFound('现金奖项不存在');
  prize.stock = Math.max(0, Math.floor(num(stock, 0)));
  prize.initial = prize.stock + num(prize.awarded, 0);
  prize.updatedAt = new Date().toISOString();
  store.save();
  store.addLog('cash', `现金库存调整：${prize.name} → ${prize.stock}`);
  return decorate(prize, effectiveProbabilities(db.cashPrizes));
}

/* ---------------- 抽奖人（独立名单与次数） ---------------- */
function addParticipant(body = {}) {
  const db = store.get();
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('姓名不能为空');
  const add = Math.floor(num(body.chances, 1));
  if (add <= 0) throw badRequest('抽奖次数必须大于 0');
  let p = db.cashParticipants.find((x) => nameKey(x.name) === nameKey(name));
  let merged = false;
  if (p) {
    p.name = name;
    p.chances = num(p.chances, 0) + add;
    merged = true;
  } else {
    p = {
      id: store.uid('cp'), name, chances: add, used: 0,
      createdAt: new Date().toISOString(), lastDrawnAt: null,
    };
    db.cashParticipants.push(p);
  }
  store.save();
  store.addLog('cash', merged ? `现金抽奖追加次数：${name} +${add}` : `现金抽奖新增参与人：${name}（${add} 次）`);
  return { participant: decoratePerson(p), merged };
}

function updateParticipant(id, patch = {}) {
  const db = store.get();
  const p = db.cashParticipants.find((x) => x.id === id);
  if (!p) throw notFound('现金抽奖人不存在');
  if (patch.name !== undefined) {
    const clean = String(patch.name).trim().replace(/\s+/g, ' ');
    if (!clean) throw badRequest('姓名不能为空');
    p.name = clean;
  }
  if (patch.chances !== undefined) p.chances = Math.max(num(p.used, 0), Math.floor(num(patch.chances, 0)));
  if (patch.addChances !== undefined) p.chances = num(p.chances, 0) + Math.floor(num(patch.addChances, 0));
  if (patch.used !== undefined) p.used = Math.max(0, Math.floor(num(patch.used, 0)));
  store.save();
  return decoratePerson(p);
}

function deleteParticipant(id) {
  const db = store.get();
  const idx = db.cashParticipants.findIndex((x) => x.id === id);
  if (idx < 0) throw notFound('现金抽奖人不存在');
  const [removed] = db.cashParticipants.splice(idx, 1);
  store.save();
  store.addLog('cash', `删除现金抽奖人：${removed.name}`);
  return { ok: true };
}

/* ---------------- 抽奖 ---------------- */
function draw(rawName) {
  const db = store.get();
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (!name) throw httpError('NAME_REQUIRED', '请输入姓名', 400);

  const person = db.cashParticipants.find((x) => nameKey(x.name) === nameKey(name));
  if (!person) throw httpError('NOT_REGISTERED', `「${name}」不在现金抽奖名单中，请联系管理员添加`, 403);
  if (num(person.chances, 0) - num(person.used, 0) <= 0) {
    throw httpError('NO_CHANCE', `「${person.name}」的现金抽奖次数已用完，请联系管理员添加新的次数`, 403);
  }

  const w = wheel();
  if (w.overflow.length) console.warn('[cash] 有奖项未上转盘:', w.overflow.join(', '));
  if (!w.segments.length) throw httpError('NO_STOCK', '现金奖品库存已发完，请联系管理员补充', 409);

  const active = (db.cashPrizes || [])
    .filter((p) => remainingWins(p) > 0)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const index = pickByProbability(active);
  if (index < 0) throw httpError('NO_STOCK', '现金奖品库存已发完，请联系管理员补充', 409);

  // 转盘上的扇区顺序与 active 一致（均按创建时间排序），保证指针落点与结果一致
  const segIndex = w.segments.findIndex((s) => s.id === active[index].id);
  const prize = active[index];
  const per = Math.max(1, num(prize.perDraw, 1));

  prize.stock = Math.max(0, num(prize.stock, 0) - per);
  prize.awarded = num(prize.awarded, 0) + per;
  prize.updatedAt = new Date().toISOString();
  person.used = num(person.used, 0) + 1;
  person.lastDrawnAt = new Date().toISOString();

  const record = {
    id: store.uid('cr'),
    name: person.name,
    prizeId: prize.id,
    prizeName: prize.name,
    amount: per,
    time: new Date().toISOString(),
    push: { status: 'pending', message: '' },
  };
  db.cashRecords.unshift(record);
  if (db.cashRecords.length > MAX_RECORDS) db.cashRecords.length = MAX_RECORDS;
  store.save();

  const text = `${person.name}抽中${prize.name}${per}份`;
  dingtalk.sendText(text)
    .then((res) => {
      record.push = { status: res.ok ? 'ok' : 'fail', message: res.message || '' };
      store.save();
      if (!res.ok) store.addLog('dingtalk', `现金中奖推送失败：${res.message}`);
      bus.emit('change');
    })
    .catch((err) => {
      record.push = { status: 'fail', message: err.message };
      store.save();
      store.addLog('dingtalk', `现金中奖推送异常：${err.message}`);
      bus.emit('change');
    });

  return {
    ok: true,
    record: { id: record.id, name: record.name, prizeName: record.prizeName, amount: record.amount, time: record.time },
    text,
    index: segIndex >= 0 ? segIndex : index,
    segmentCount: w.segments.length,
    remaining: Math.max(0, num(person.chances, 0) - num(person.used, 0)),
    used: person.used,
    chances: person.chances,
    prize: decorate(prize, effectiveProbabilities(db.cashPrizes)),
    stats: stats(),
  };
}

function reset(what) {
  const db = store.get();
  if (['records', 'all'].includes(what)) db.cashRecords = [];
  if (what === 'all') {
    db.cashPrizes = [];
    db.cashParticipants = [];
  }
  if (what === 'stock') {
    db.cashPrizes.forEach((p) => { p.stock = num(p.initial, 0); p.awarded = 0; });
  }
  if (what === 'chances') {
    db.cashParticipants.forEach((p) => { p.used = 0; });
  }
  store.save();
  store.addLog('cash', `现金抽奖重置：${what}`);
  return { ok: true };
}

module.exports = {
  MAX_SEGMENTS,
  num,
  remainingWins,
  effectiveProbabilities,
  pickByProbability,
  decorate,
  decoratePerson,
  publicState,
  wheel,
  stats,
  upsertPrize,
  importPrizes,
  deletePrize,
  restockPrize,
  addParticipant,
  updateParticipant,
  deleteParticipant,
  draw,
  reset,
};

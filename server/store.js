'use strict';

/**
 * 极简 JSON 持久化存储
 * - 启动时载入到内存，所有写操作同步落盘（先写 .tmp 再 rename，避免半截文件）
 * - 单进程内通过队列串行化写盘，保证并发抽奖时库存不会算错
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// 注意：不要用 .tmp 后缀，部分安全软件会拦截；也不复用 db.json（可能被系统文件保护锁住）
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'lottery-data.json');
const TMP_FILE = DATA_FILE + '.new';
const LEGACY_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_CONFIG = {
  password: 'CHANGE_ME_2026',
  webhook: 'https://oapi.dingtalk.com/robot/send?access_token=REPLACE_WITH_YOUR_DINGTALK_TOKEN',
  secret: '',
  soundOn: true,
  maxSegments: 12,
  atAll: false,
  // 库存日报：每天按北京时间定时推送到钉钉群
  stockReport: { on: true, time: '18:30', lastDate: '' },
  // 两个团队：id 固定，展示名可在后台改
  teams: { cc: 'CC 团队', lp: 'LP 团队' },
};

const TEAM_IDS = ['cc', 'lp'];

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function emptyDb() {
  return {
    version: 3,
    config: { ...DEFAULT_CONFIG, teams: { ...DEFAULT_CONFIG.teams }, stockReport: { ...DEFAULT_CONFIG.stockReport } },
    prizes: [],
    participants: [],
    records: [],
    // 现金抽奖（仅 CC 团队）：与实物完全独立的数据域
    cashPrizes: [],
    cashParticipants: [],
    cashRecords: [],
    logs: [],
  };
}

let db = null;
let writing = false;
let dirty = false;

function normalize(raw) {
  const base = emptyDb();
  if (!raw || typeof raw !== 'object') return base;
  const cfg = { ...DEFAULT_CONFIG, ...(raw.config || {}) };
  if (!cfg.teams || typeof cfg.teams !== 'object') cfg.teams = { ...DEFAULT_CONFIG.teams };
  if (!cfg.stockReport || typeof cfg.stockReport !== 'object') cfg.stockReport = { ...DEFAULT_CONFIG.stockReport };
  cfg.stockReport = { ...DEFAULT_CONFIG.stockReport, ...cfg.stockReport };
  TEAM_IDS.forEach((id) => {
    if (!cfg.teams[id]) cfg.teams[id] = DEFAULT_CONFIG.teams[id];
  });

  const withTeam = (x) => (x && typeof x === 'object' ? { ...x, team: TEAM_IDS.includes(x.team) ? x.team : 'cc' } : x);
  // 老数据没有 probability：补 0 表示「未配置」，抽奖时降级为按库存加权（行为不变）
  const withProbability = (x) => (x && typeof x === 'object' && x.probability === undefined ? { ...x, probability: 0 } : x);

  return {
    version: 3,
    config: cfg,
    prizes: (Array.isArray(raw.prizes) ? raw.prizes : []).map(withTeam).map(withProbability),
    participants: (Array.isArray(raw.participants) ? raw.participants : []).map(withTeam),
    records: (Array.isArray(raw.records) ? raw.records : []).map(withTeam),
    cashPrizes: Array.isArray(raw.cashPrizes) ? raw.cashPrizes : [],
    cashParticipants: Array.isArray(raw.cashParticipants) ? raw.cashParticipants : [],
    cashRecords: Array.isArray(raw.cashRecords) ? raw.cashRecords : [],
    logs: Array.isArray(raw.logs) ? raw.logs : [],
  };
}

function load() {
  if (db) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let source = null;
    if (fs.existsSync(DATA_FILE)) {
      source = DATA_FILE;
    } else if (fs.existsSync(LEGACY_FILE)) {
      source = LEGACY_FILE; // 老版本数据文件，自动迁移
    }

    if (source) {
      const txt = fs.readFileSync(source, 'utf8');
      db = normalize(JSON.parse(txt || '{}'));
      if (source === LEGACY_FILE) {
        console.log('[store] 已从旧数据文件 db.json 迁移到', path.basename(DATA_FILE));
        flushNow();
      }
    } else {
      db = emptyDb();
      flushNow();
    }
  } catch (err) {
    console.error('[store] 读取数据失败，使用空数据启动:', err.message);
    try {
      if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, path.join(DATA_DIR, `backup.${Date.now()}.json`));
    } catch (_) {}
    db = emptyDb();
  }
  return db;
}

function flushNow() {
  const payload = JSON.stringify(db, null, 2);

  // 1) 原子写：先写临时文件再 rename（Windows 上偶发文件占用，重试 3 次）
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.writeFileSync(TMP_FILE, payload, 'utf8');
      fs.renameSync(TMP_FILE, DATA_FILE);
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  // 2) 降级：直接覆盖写入（可能非原子，但保证数据落盘）
  try {
    fs.writeFileSync(DATA_FILE, payload, 'utf8');
    if (fs.existsSync(TMP_FILE)) {
      try { fs.unlinkSync(TMP_FILE); } catch (_) {}
    }
    console.warn('[store] rename 失败，已降级为直接写入:', lastErr && lastErr.code);
  } catch (err2) {
    console.error('[store] 落盘彻底失败:', err2.message);
    throw err2;
  }
}

/** 标记为脏并异步落盘 */
function save() {
  dirty = true;
  if (writing) return;
  writing = true;
  setImmediate(() => {
    try {
      if (dirty) {
        dirty = false;
        flushNow();
      }
    } catch (err) {
      console.error('[store] 落盘失败:', err.message);
    } finally {
      writing = false;
      if (dirty) save();
    }
  });
}

function get() {
  return load();
}

function addLog(type, text) {
  const d = get();
  d.logs.unshift({ id: uid('log'), type, text, time: new Date().toISOString() });
  if (d.logs.length > 300) d.logs.length = 300;
  save();
}

module.exports = { get, save, addLog, uid, DATA_FILE, DEFAULT_CONFIG, TEAM_IDS };

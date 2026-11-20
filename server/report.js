'use strict';

/**
 * 每日库存日报
 * 按北京时间每天定时把两个团队的库存情况推送到钉钉群。
 *
 * 文案格式：
 *   当前抽奖礼品库存如下：
 *   ↓CC团队↓
 *   保温杯已发放2，剩余库存6份，可抽6次；
 *   ↓LP团队↓
 *   显示器已发放1，剩余库存1份，可抽1次；
 */

const store = require('./store');
const lottery = require('./lottery');
const dingtalk = require('./dingtalk');

const TZ = 'Asia/Shanghai';

/** 取北京时间的当前日期与时分（不依赖服务器时区） */
function nowInShanghai() {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24; // 个别环境午夜返回 24
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
    text: `${String(hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
  };
}

/** 拼出日报文案 */
function buildStockReport() {
  const db = store.get();
  const lines = ['当前抽奖礼品库存如下：'];

  lottery.TEAM_IDS.forEach((id) => {
    // 团队名去掉空格，贴合「↓CC团队↓」的样式
    const name = String(lottery.teamName(id) || id).replace(/\s+/g, '');
    lines.push(`↓${name}↓`);

    const prizes = lottery.scope(db.prizes, id);
    if (!prizes.length) {
      lines.push('（暂无礼品）');
      return;
    }
    prizes.forEach((p) => {
      const awarded = Number(p.awarded) || 0;
      const stock = Number(p.stock) || 0;
      const wins = lottery.remainingWins(p);
      lines.push(`${p.name}已发放${awarded}，剩余库存${stock}份，可抽${wins}次；`);
    });
  });

  return lines.join('\n');
}

async function sendStockReport(reason) {
  const text = buildStockReport();
  const result = await dingtalk.sendText(text);
  store.addLog(
    'report',
    result.ok
      ? `库存日报已推送（${reason || '手动'}）`
      : `库存日报推送失败（${reason || '手动'}）：${result.message}`,
  );
  return { ok: result.ok, message: result.message, text };
}

/**
 * 每分钟检查一次：到点且今天还没发过，就推送
 * 允许在 [设定时间, 设定时间+29分钟] 内补发（应对重启后错过整点）
 */
function tick() {
  const db = store.get();
  const cfg = db.config.stockReport || {};
  if (!cfg.on) return;
  if (!db.config.webhook) return;

  const [h, m] = String(cfg.time || '18:30').split(':').map((x) => Number(x) || 0);
  const now = nowInShanghai();

  if (now.hour !== h) return;
  if (now.minute < m || now.minute > m + 29) return;
  if (cfg.lastDate === now.date) return;

  // 先占位，避免并发/重入导致重复发送
  cfg.lastDate = now.date;
  store.save();

  sendStockReport('定时').then((r) => {
    if (!r.ok) {
      // 推送失败则允许本次重试（下次 tick 再试）
      cfg.lastDate = '';
      store.save();
    }
  });
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error('[report] 日报调度异常:', err.message);
    }
  }, 60 * 1000);
  timer.unref && timer.unref();
  console.log(`  ⏰ 库存日报：${store.get().config.stockReport.on ? '已开启' : '已关闭'}，每天 ${store.get().config.stockReport.time}（北京时间）`);
}

module.exports = { buildStockReport, sendStockReport, start, nowInShanghai, tick };

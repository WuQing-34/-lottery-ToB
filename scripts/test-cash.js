'use strict';
/**
 * CC 现金抽奖端到端测试
 * - 与实物抽奖的库存 / 名单 / 次数 / 记录完全隔离
 * - 概率可控、按权重抽取、库存售罄自动退出
 * - Excel 导入导出、钉钉文案
 * 钉钉指向本地 mock，跑完还原真实 webhook。
 */
const http = require('http');
const XLSX = require('xlsx');
const cash = require('../server/cash');

const BASE = process.env.BASE || 'http://127.0.0.1:8082';
const MOCK_PORT = 4001;
const REAL_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=REPLACE_WITH_YOUR_DINGTALK_TOKEN';
const received = [];
let token = '';
let fail = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail += 1; };
const section = (t) => console.log('\n=== ' + t + ' ===');

async function api(path, opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  if (token && !o.headers['x-admin-token']) o.headers['x-admin-token'] = token;
  const res = await fetch(BASE + path, o);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function mockServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { received.push(JSON.parse(body)); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      });
    });
    srv.listen(MOCK_PORT, () => resolve(srv));
  });
}

(async function main() {
  const mock = await mockServer();
  section('1. 登录与清空');
  let r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'CHANGE_ME_2026' }) });
  check(r.status === 200 && !!r.data.token, '登录成功'); token = r.data.token;
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'all', team: 'all' }) });
  await api('/api/admin/cash/reset', { method: 'POST', body: JSON.stringify({ what: 'all' }) });
  await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ webhook: `http://127.0.0.1:${MOCK_PORT}/robot` }) });

  section('2. 现金奖项导入与概率');
  const rows = [
    { name: '100元现金', amount: 100, stock: 3, perDraw: 1, probability: 10 },
    { name: '50元现金', amount: 50, stock: 5, perDraw: 1, probability: 20 },
    { name: '谢谢参与', amount: 0, stock: 100, perDraw: 1, probability: 70 },
  ];
  r = await api('/api/admin/cash/prizes/import', { method: 'POST', body: JSON.stringify({ rows, mode: 'replace' }) });
  check(r.status === 200 && r.data.created === 3, `导入 3 个现金奖项（created=${r.data.created}）`);
  r = await api('/api/cash/state');
  const prizes = r.data.prizes || [];
  check(prizes.length === 3, '现金奖项数 3');
  const eff = prizes.map((p) => p.effectiveProbability).sort((a, b) => a - b);
  check(JSON.stringify(eff) === JSON.stringify([10, 20, 70]), `实际概率 ${eff.join('/')}% 与设置一致`);
  check(prizes.find((p) => p.name === '100元现金').amount === 100, '金额字段已保存');
  const goods = await api('/api/state?team=cc');
  check(goods.data.prizes.length === 0, '实物库存为空（未受现金导入影响）');

  section('3. 概率加权算法（可注入随机源）');
  const a = [
    { id: 'a', stock: 10, perDraw: 1, probability: 10 },
    { id: 'b', stock: 10, perDraw: 1, probability: 20 },
    { id: 'c', stock: 10, perDraw: 1, probability: 0 },
    { id: 'd', stock: 10, perDraw: 1, probability: 70 },
  ];
  check(cash.pickByProbability(a, () => 0.05) === 0, 'rand=0.05 命中 10% 奖项');
  check(cash.pickByProbability(a, () => 0.2) === 1, 'rand=0.20 命中 20% 奖项');
  check(cash.pickByProbability(a, () => 0.5) === 3, 'rand=0.50 命中 70% 奖项');
  let zeroHit = 0;
  for (let i = 0; i < 1000; i += 1) if (cash.pickByProbability(a) === 2) zeroHit += 1;
  check(zeroHit === 0, '概率为 0 的奖项 1000 次抽取均未命中');
  const b = [{ id: 'x', stock: 10, perDraw: 1, probability: 0 }, { id: 'y', stock: 10, perDraw: 1, probability: 0 }];
  check([0, 1].includes(cash.pickByProbability(b)), '全部概率为 0 时降级为均分，不报错');
  const exhausted = [{ id: 'z', stock: 0, perDraw: 1, probability: 100 }, { id: 'k', stock: 3, perDraw: 1, probability: 1 }];
  check(cash.pickByProbability(exhausted, () => 0.99) === 0, '库存发完的奖项被跳过（返回值按有效奖项重新索引）');

  section('4. 概率转盘扇区（等分，与概率解耦）');
  r = await api('/api/cash/wheel');
  const segs = r.data.segments || [];
  check(segs.length === 3, '转盘 3 个扇区');
  check(segs.every((s) => s.weight === undefined), '扇区不再下发 weight（面积与概率解耦）');
  check(JSON.stringify(segs.map((s) => s.probability)) === JSON.stringify([10, 20, 70]), '扇区仍携带实际概率供展示');
  check(Math.abs(r.data.probabilitySum - 100) < 0.01, '概率合计 100%');

  section('5. 名单与次数完全隔离');
  r = await api('/api/admin/cash/participants', { method: 'POST', body: JSON.stringify({ name: '张三', chances: 2 }) });
  check(r.status === 200 && r.data.participant.left === 2, '现金名单新增张三，2 次');
  r = await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '张三', chances: 2, team: 'cc' }) });
  check(r.status === 200 && r.data.participant.left === 2, '实物名单同样新增张三，2 次');
  r = await api('/api/cash/me?name=%E5%BC%A0%E4%B8%89');
  check(r.data.participant.left === 2, '现金接口读到 2 次');
  r = await api('/api/me?team=cc&name=%E5%BC%A0%E4%B8%89');
  check(r.data.participant.left === 2, '实物接口读到 2 次（互不影响）');

  section('6. 现金抽奖与钉钉文案');
  await wait(1600);
  r = await api('/api/cash/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  check(r.status === 200 && r.data.record, `现金抽奖成功：${r.data.record && r.data.record.prizeName}`);
  const drawn = r.data.record;
  check(/^张三抽中.+\d+份$/.test(r.data.text), `钉钉文案带数量：「${r.data.text}」`);
  const cashAfter = await api('/api/cash/state');
  const pAfter = cashAfter.data.prizes.find((p) => p.id === r.data.prize.id);
  check(pAfter.stock === pAfter.initial - drawn.amount && pAfter.awarded === drawn.amount, `现金库存扣减 ${drawn.amount} 份`);
  const cashPerson = cashAfter.data.participants.find((p) => p.name === '张三');
  check(cashPerson.used === 1 && cashPerson.left === 1, '现金次数扣 1');
  const goodsAfter = await api('/api/state?team=cc');
  const goodsPerson = goodsAfter.data.participants.find((p) => p.name === '张三');
  check(goodsPerson.used === 0 && goodsPerson.left === 2, '实物次数未变（仍在名单、仍可抽 2 次）');
  check(goodsAfter.data.prizes.length === 0, '实物库存未变');
  await wait(350);
  check(received.length === 1 && received[0].text.content === r.data.text, '本地 mock 收到 1 条钉钉消息且内容一致');

  section('7. 次数耗尽与独立追加');
  await wait(1600);
  r = await api('/api/cash/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  check(r.status === 200, '第二次现金抽奖成功');
  await wait(1600);
  r = await api('/api/cash/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  check(r.status === 403 && r.data.code === 'NO_CHANCE', '现金次数用完被拒绝');
  r = await api('/api/cash/me?name=%E5%BC%A0%E4%B8%89');
  check(r.data.participant.status === 'done', '现金名单显示已抽奖');
  r = await api('/api/admin/cash/participants/' + r.data.participant.id, { method: 'PATCH', body: JSON.stringify({ addChances: 1 }) });
  check(r.data.participant.left === 1, '单独追加现金次数后立即恢复');
  r = await api('/api/me?team=cc&name=%E5%BC%A0%E4%B8%89');
  check(r.data.participant.used === 0, '实物次数仍未被使用');

  section('8. 独立重置');
  await api('/api/admin/cash/reset', { method: 'POST', body: JSON.stringify({ what: 'stock' }) });
  r = await api('/api/cash/state');
  check(r.data.stats.totalAwarded === 0 && r.data.stats.totalStock === 108, '现金库存已恢复（初始 108 份）');
  r = await api('/api/admin/cash/reset', { method: 'POST', body: JSON.stringify({ what: 'chances' }) });
  r = await api('/api/cash/state');
  check(r.data.participants.find((p) => p.name === '张三').left === 3, '现金次数已清零恢复（2+1）');
  r = await api('/api/state?team=cc');
  check(r.data.participants.find((p) => p.name === '张三').left === 2, '实物次数不受影响');

  section('9. Excel 导出');
  const xres = await fetch(BASE + '/api/admin/cash/export/inventory.xlsx', { headers: { 'x-admin-token': token } });
  const book = XLSX.read(Buffer.from(await xres.arrayBuffer()), { type: 'buffer' });
  const sheet = book.Sheets[book.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  check(xres.status === 200 && book.SheetNames.length === 1, '现金库存表可下载且仅 1 个工作表');
  check(matrix[0].includes('设置概率(%)') && matrix[0].includes('实际概率(%)'), '导出表含设置概率与实际概率列');
  const cres = await fetch(BASE + '/api/admin/cash/export', { headers: { 'x-admin-token': token } });
  const csv = await cres.text();
  check(cres.status === 200 && csv.includes('张三') && csv.includes('抽中'), '现金记录 CSV 可下载');

  section('10. 非法参数与还原');
  r = await api('/api/admin/cash/prizes', { method: 'POST', body: JSON.stringify({ name: '', stock: 5 }) });
  check(r.status === 400, '空奖项名被拒绝');
  r = await api('/api/cash/draw', { method: 'POST', body: JSON.stringify({ name: '不在名单' }) });
  check(r.status === 403 && r.data.code === 'NOT_REGISTERED', '未登记的人不能抽现金');
  r = await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ webhook: REAL_WEBHOOK }) });
  const cfg = await api('/api/admin/state?team=cc');
  check(cfg.data.config.webhook === REAL_WEBHOOK, 'webhook 已还原为真实地址');

  mock.close();
  console.log('\n' + (fail ? '✗ 失败 ' + fail + ' 项' : '✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

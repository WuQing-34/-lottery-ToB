'use strict';
/**
 * 双团队端到端测试
 * - 库存 / 名单 / 记录 / 转盘 / 中奖是否按团队完全隔离
 * - 同名用户可在两个团队分别存在且各自计数
 * - 库存 Excel 导出、记录 CSV 导出
 * 钉钉推送指向本地 mock，不会打扰真实群；跑完会还原真实 webhook。
 */
const http = require('http');
const XLSX = require('xlsx');
const lottery = require('../server/lottery');

const BASE = process.env.BASE || 'http://127.0.0.1:8082';
const MOCK_PORT = 3998;
const REAL_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=REPLACE_WITH_YOUR_DINGTALK_TOKEN';

const received = [];
let token = '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fail += 1;
};
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
        try { received.push(JSON.parse(body)); } catch (_) { received.push(body); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      });
    });
    srv.listen(MOCK_PORT, () => resolve(srv));
  });
}

(async function main() {
  const mock = await mockServer();

  section('1. 登录与团队列表');
  let r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'CHANGE_ME_2026' }) });
  check(r.status === 200 && r.data.token, '登录成功');
  token = r.data.token;

  r = await api('/api/teams');
  check(r.status === 200 && r.data.teams.length === 2, `共 ${r.data.teams.length} 个团队：${r.data.teams.map((t) => t.name).join(' / ')}`);

  section('2. 清空并分别导入两个团队的礼品');
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'all', team: 'all' }) });
  await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ webhook: `http://127.0.0.1:${MOCK_PORT}/robot` }) });

  const ccRows = [
    { name: 'AirPods Pro', stock: 3, perDraw: 1, probability: 10 },
    { name: '机械键盘', stock: 5, perDraw: 1, probability: 20 },
    { name: 'CC 卫衣', stock: 10, perDraw: 2, probability: 70 },
  ];
  // LP 不配置概率：验证老数据按库存可抽次数加权的降级行为
  const lpRows = [
    { name: '显示器', stock: 2, perDraw: 1 },
    { name: 'LP 双肩包', stock: 6, perDraw: 1 },
  ];
  r = await api('/api/admin/prizes/import', { method: 'POST', body: JSON.stringify({ rows: ccRows, mode: 'replace', team: 'cc' }) });
  check(r.status === 200 && r.data.created === 3, `CC 导入 3 个礼品（created=${r.data.created}）`);
  r = await api('/api/admin/prizes/import', { method: 'POST', body: JSON.stringify({ rows: lpRows, mode: 'replace', team: 'lp' }) });
  check(r.status === 200 && r.data.created === 2, `LP 导入 2 个礼品（created=${r.data.created}）`);

  r = await api('/api/admin/state?team=cc');
  check(r.data.prizes.length === 3, `CC 只有自己的 3 个礼品（实际 ${r.data.prizes.length}）`);
  check(r.data.stats.availableWins === 3 + 5 + 5, `CC 剩余可抽次数 = ${r.data.stats.availableWins}（3+5+5）`);

  r = await api('/api/admin/state?team=lp');
  check(r.data.prizes.length === 2, `LP 只有自己的 2 个礼品（实际 ${r.data.prizes.length}）`);
  check(r.data.stats.availableWins === 2 + 6, `LP 剩余可抽次数 = ${r.data.stats.availableWins}（2+6）`);

  section('3. 转盘按团队独立');
  let w1 = (await api('/api/wheel?team=cc')).data;
  let w2 = (await api('/api/wheel?team=lp')).data;
  check(w1.segments.length === 3 && w2.segments.length === 2, `CC 转盘 ${w1.segments.length} 格 / LP 转盘 ${w2.segments.length} 格`);
  check(!w1.segments.some((s) => s.name.includes('LP')), 'CC 转盘里没有 LP 的奖品');
  check(!w2.segments.some((s) => s.name.includes('CC')), 'LP 转盘里没有 CC 的奖品');
  check(w1.segments.every((s) => s.weight === undefined), '实物扇区不下发 weight（面积与概率解耦）');
  check(JSON.stringify(w1.segments.map((s) => s.probability)) === JSON.stringify([10, 20, 70]), 'CC 扇区携带实际概率 10/20/70');
  check(Math.abs(w1.probabilitySum - 100) < 0.01, 'CC 设置概率合计 100%');
  check(JSON.stringify(w2.segments.map((s) => s.probability)) === JSON.stringify([25, 75]), 'LP 未配置概率时按库存可抽次数换算（2/6 → 25/75）');

  section('3b. 实物概率算法');
  r = await api('/api/admin/state?team=cc');
  const eff = r.data.prizes.map((p) => p.effectiveProbability).sort((a, b) => a - b);
  check(JSON.stringify(eff) === JSON.stringify([10, 20, 70]), `后台实际概率 ${eff.join('/')}% 与设置一致`);
  const plist = [
    { id: 'a', stock: 10, perDraw: 1, probability: 10 },
    { id: 'b', stock: 10, perDraw: 1, probability: 20 },
    { id: 'c', stock: 10, perDraw: 1, probability: 0 },
    { id: 'd', stock: 10, perDraw: 1, probability: 70 },
  ];
  check(lottery.pickByProbability(plist, () => 0.05) === 0, 'rand=0.05 命中 10% 礼品');
  check(lottery.pickByProbability(plist, () => 0.2) === 1, 'rand=0.20 命中 20% 礼品');
  check(lottery.pickByProbability(plist, () => 0.5) === 3, 'rand=0.50 命中 70% 礼品');
  let zeroHit = 0;
  for (let i = 0; i < 1000; i += 1) if (lottery.pickByProbability(plist) === 2) zeroHit += 1;
  check(zeroHit === 0, '概率 0 的礼品 1000 次抽取均未命中');
  const legacy = [{ id: 'x', stock: 3, perDraw: 1, probability: 0 }, { id: 'y', stock: 1, perDraw: 1, probability: 0 }];
  check(lottery.pickByProbability(legacy, () => 0.5) === 0, '全部未配置概率时按库存可抽次数加权（3:1，0.5 落在第一项）');
  check(lottery.pickByProbability(legacy, () => 0.9) === 1, '未配置概率时 0.9 落在第二项');
  const effLegacy = lottery.effectiveProbabilities(legacy);
  check(Math.abs(effLegacy.x - 75) < 0.01 && Math.abs(effLegacy.y - 25) < 0.01, '未配置概率时实际概率按库存换算 75/25');

  section('4. 同名用户可在两个团队独立存在');
  r = await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '张三', chances: 1, team: 'cc' }) });
  check(r.status === 200 && !r.data.merged && r.data.participant.left === 1, 'CC 新增张三 1 次');
  r = await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '张三', chances: 2, team: 'lp' }) });
  check(r.status === 200 && !r.data.merged && r.data.participant.left === 2, 'LP 也新增张三 2 次（独立记录，不是累加）');

  r = await api('/api/me?team=cc&name=' + encodeURIComponent('张三'));
  check(r.data.participant.left === 1, 'CC 的张三剩余 1 次');
  r = await api('/api/me?team=lp&name=' + encodeURIComponent('张三'));
  check(r.data.participant.left === 2, 'LP 的张三剩余 2 次');

  r = await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '李四', chances: 2, team: 'lp' }) });
  check(r.status === 200, 'LP 新增李四 2 次');
  r = await api('/api/me?team=cc&name=' + encodeURIComponent('李四'));
  check(r.status === 404, '李四只属于 LP，在 CC 查不到（团队隔离生效）');

  section('5. 抽奖互不影响');
  await wait(1600);
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三', team: 'cc' }) });
  check(r.status === 200 && r.data.ok, `CC 张三抽中「${r.data.record && r.data.record.prizeName}」`);
  await wait(300);
  const expectText = `张三抽中${r.data.record.prizeName}${r.data.record.amount}份`;
  check(received.length === 1 && received[0].text.content === expectText, `钉钉文案正确（[姓名]抽中[奖品][数量]份）：${received[0] && received[0].text.content}`);

  let ccState = (await api('/api/admin/state?team=cc')).data;
  let lpState = (await api('/api/admin/state?team=lp')).data;
  const ccTotalBefore = 3 + 5 + 5;
  check(ccState.stats.availableWins === ccTotalBefore - 1, `CC 可抽次数 -1 → ${ccState.stats.availableWins}`);
  check(lpState.stats.availableWins === 8, `LP 库存完全没动 → ${lpState.stats.availableWins}`);
  check(lpState.records.length === 0, 'LP 的记录里没有 CC 的中奖记录');

  section('6. 次数用尽只影响本团队');
  await wait(1600);
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三', team: 'cc' }) });
  check(r.status === 403 && r.data.code === 'NO_CHANCE', 'CC 张三次数用完被拒绝');
  await wait(1600);
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三', team: 'lp' }) });
  check(r.status === 200, `LP 张三仍可正常抽奖，抽中「${r.data.record && r.data.record.prizeName}」`);

  section('7. 一个团队发完不影响另一个');
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'all', team: 'lp' }) });
  await api('/api/admin/prizes/import', { method: 'POST', body: JSON.stringify({ rows: [{ name: '绝版奖', stock: 1, perDraw: 1 }], mode: 'replace', team: 'lp' }) });
  await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '王五', chances: 3, team: 'lp' }) });
  await wait(1600);
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '王五', team: 'lp' }) });
  check(r.status === 200, 'LP 王五抽走最后一份「绝版奖」');
  await wait(1600);
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '王五', team: 'lp' }) });
  check(r.status === 409 && r.data.code === 'NO_STOCK', 'LP 无库存 → NO_STOCK，且不扣次数');
  ccState = (await api('/api/admin/state?team=cc')).data;
  check(ccState.stats.availableWins === ccTotalBefore - 1, `CC 库存不受 LP 发完影响 → ${ccState.stats.availableWins}`);

  section('8. 恢复库存只作用于当前团队');
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'stock', team: 'lp' }) });
  lpState = (await api('/api/admin/state?team=lp')).data;
  check(lpState.stats.availableWins === 1, `LP 恢复库存 → 可抽 ${lpState.stats.availableWins} 次`);
  ccState = (await api('/api/admin/state?team=cc')).data;
  check(ccState.stats.availableWins === ccTotalBefore - 1, `CC 库存未变 → ${ccState.stats.availableWins}`);

  section('9. 库存导出 Excel');
  const resX = await fetch(BASE + '/api/admin/export/inventory.xlsx?team=all', { headers: { 'x-admin-token': token } });
  const ct = resX.headers.get('content-type') || '';
  const buf = Buffer.from(await resX.arrayBuffer());
  check(resX.status === 200 && ct.includes('spreadsheetml'), `返回 xlsx（${(buf.length / 1024).toFixed(1)} KB, ${ct.split(';')[0]}）`);
  const wb = XLSX.read(buf, { type: 'buffer' });
  check(wb.SheetNames.length === 3, `工作簿包含 ${wb.SheetNames.length} 个工作表：${wb.SheetNames.join(' / ')}`);
  const ccSheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], { header: 1 });
  check(ccSheet.length >= 4 && String(ccSheet[0][1]).includes('礼品'), '明细表有表头与数据行');
  check(ccSheet[0].includes('设置概率(%)') && ccSheet[0].includes('实际概率(%)'), '库存导出含设置概率/实际概率两列');
  check(ccSheet.some((row) => row.includes('AirPods Pro')), 'CC 明细表里能读到 AirPods Pro');
  const sum = XLSX.utils.sheet_to_json(wb.Sheets['团队汇总'], { header: 1 });
  check(sum.length === 3, `团队汇总表 ${sum.length - 1} 行（不含表头）`);

  const oneTeam = await fetch(BASE + '/api/admin/export/inventory.xlsx?team=cc', { headers: { 'x-admin-token': token } });
  const oneBuf = Buffer.from(await oneTeam.arrayBuffer());
  const wb2 = XLSX.read(oneBuf, { type: 'buffer' });
  check(wb2.SheetNames.length === 1, `单团队导出只有 1 个表：${wb2.SheetNames[0]}`);

  section('10. 记录导出与团队隔离');
  const csv = await fetch(BASE + '/api/admin/export?team=cc', { headers: { 'x-admin-token': token } });
  const csvText = await csv.text();
  check(csvText.includes('张三') && !csvText.includes('王五'), 'CC 记录 CSV 只含 CC 的中奖记录');

  section('11. 参数校验');
  r = await api('/api/admin/state?team=xx');
  check(r.status === 400, '非法团队参数被拒绝');
  r = await api('/api/admin/prizes', { method: 'POST', body: JSON.stringify({ name: '测试', stock: 1, perDraw: 1, team: 'zz' }) });
  check(r.status === 400, '新增礼品时非法团队被拒绝');
  r = await api('/api/wheel?team=cc');
  check(r.status === 200, '正常团队仍工作');

  section('12. 库存日报');
  r = await api('/api/admin/stock-report/preview');
  const rep = r.data.text || '';
  check(r.status === 200 && rep.startsWith('当前抽奖礼品库存如下：'), '日报第一行是「当前抽奖礼品库存如下：」');
  check(rep.includes('↓CC团队↓') && rep.includes('↓LP团队↓'), '包含 ↓CC团队↓ 与 ↓LP团队↓ 两段');
  const lineOk = /^.+已发放\d+，剩余库存\d+份，可抽\d+次；$/.test(rep.split('\n').find((l) => l.includes('已发放')) || '');
  check(lineOk, '单行格式为「X已发放N，剩余库存M份，可抽K次；」');
  check(!/\s/.test(rep.split('\n')[1] || ''), '团队标题里没有多余空格');

  const before = received.length;
  r = await api('/api/admin/stock-report/send', { method: 'POST', body: '{}' });
  await wait(400);
  check(r.status === 200 && r.data.ok, '手动推送日报成功');
  check(received.length === before + 1 && received[received.length - 1].text.content.includes('当前抽奖礼品库存如下：'), '钉钉收到了日报内容');

  r = await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ stockReport: { on: false, time: '19:45' } }) });
  const sr = (await api('/api/admin/state?team=cc')).data.config.stockReport;
  check(sr.on === false && sr.time === '19:45', `日报配置可改并持久化（on=${sr.on}, time=${sr.time}）`);
  r = await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ stockReport: { on: true, time: '18:30' } }) });
  check(r.status === 200, '配置还原为 18:30 开启');

  // 还原真实 webhook
  await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ webhook: REAL_WEBHOOK }) });
  const cfg = (await api('/api/admin/state?team=cc')).data.config;
  check(cfg.webhook === REAL_WEBHOOK, 'webhook 已还原为真实地址');

  console.log(`\nmock 共收到 ${received.length} 条钉钉消息：`);
  received.forEach((m, i) => console.log(`  ${i + 1}. ${m.text ? m.text.content : JSON.stringify(m)}`));

  mock.close();
  console.log('\n' + (fail ? `存在 ${fail} 项失败 ✗` : '双团队用例全部通过 ✓') + '\n');
  process.exit(fail ? 1 : 0);
})();

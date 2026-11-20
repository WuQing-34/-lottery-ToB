'use strict';
/**
 * 端到端流程测试
 * 1. 起一个本地 mock 接收钉钉消息
 * 2. 登录 → 导入 Excel 数据 → 添加抽奖人 → 抽奖 → 校验库存/次数/状态
 */
const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:8082';
const MOCK_PORT = 3999;
const received = [];

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

let token = '';
const TEAM = process.env.TEAM || 'cc'; // 双团队版：默认在 CC 团队上跑单团队回归
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  if (token && !o.headers['x-admin-token']) o.headers['x-admin-token'] = token;
  // 自动补上 team 字段（reset 需要显式 all，故排除）
  if (o.body && typeof o.body === 'string' && !path.includes('/reset') && !path.includes('/config')) {
    try {
      const b = JSON.parse(o.body);
      if (b && typeof b === 'object' && b.team === undefined) {
        b.team = TEAM;
        o.body = JSON.stringify(b);
      }
    } catch (_) {}
  }
  const res = await fetch(BASE + path, o);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function pass(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { console.log('  ✗ ' + msg); process.exitCode = 1; }
function check(cond, msg) { cond ? pass(msg) : fail(msg); }

(async function main() {
  const mock = await mockServer();
  console.log('\n=== 1. 登录 ===');
  let r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'CHANGE_ME_2026' }) });
  check(r.status === 200 && r.data.token, '默认密码登录成功');
  token = r.data.token;

  r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  check(r.status === 401, '错误密码被拒绝');

  r = await api('/api/admin/state', { headers: { 'x-admin-token': 'bad' } });
  check(r.status === 401, '无 token 访问被拒绝');

  console.log('\n=== 2. 指向 mock webhook 并清空数据 ===');
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'all' }) });
  r = await api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ webhook: `http://127.0.0.1:${MOCK_PORT}/robot/send` }) });
  check(r.status === 200, 'webhook 已切换到本地 mock');

  console.log('\n=== 3. Excel 导入（模拟解析结果） ===');
  const rows = [
    { name: '保温杯', stock: 4, perDraw: 1 },
    { name: '蓝牙音箱', stock: 2, perDraw: 1 },
    { name: '100元购物卡', stock: 3, perDraw: 1 },
    { name: '定制帆布袋', stock: 6, perDraw: 2 },
  ];
  r = await api('/api/admin/prizes/import', { method: 'POST', body: JSON.stringify({ rows, mode: 'replace' }) });
  check(r.status === 200 && r.data.created === 4, `导入 4 个礼品（created=${r.data.created}）`);

  r = await api('/api/admin/state');
  const available = r.data.stats.availableWins;
  check(available === 4 + 2 + 3 + 3, `剩余可抽次数计算正确 = ${available}（4+2+3+3）`);

  const cup = r.data.prizes.find((p) => p.name === '保温杯');
  check(cup.initial === 4 && cup.stock === 4 && cup.awarded === 0, '初始库存/已发放字段正确');

  r = await api('/api/wheel');
  check(r.data.segments.length === 4, '转盘生成 4 个扇区');

  console.log('\n=== 4. 添加抽奖人 ===');
  r = await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '张三', chances: 2 }) });
  check(r.status === 200 && r.data.participant.left === 2, '张三 2 次，剩余 2');
  r = await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '张三', chances: 1 }) });
  check(r.data.merged === true && r.data.participant.left === 3, '同名再加 1 次 → 累加为剩余 3');

  console.log('\n=== 5. 未登记的人不能抽 ===');
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '李四' }) });
  check(r.status === 403 && r.data.code === 'NOT_REGISTERED', '李四未登记被拒绝（NOT_REGISTERED）');

  console.log('\n=== 6. 抽奖扣减与推送 ===');
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  check(r.status === 200 && r.data.ok, `张三抽中「${r.data.record && r.data.record.prizeName}」`);
  const drawn = r.data;
  check(drawn.remaining === 2, `抽后剩余次数 = ${drawn.remaining}`);

  const segNames = (await api('/api/wheel')).data.segments.map((s) => s.name);
  check(segNames[drawn.index] === drawn.record.prizeName, '返回的扇区下标与中奖奖品一致');

  await new Promise((res) => setTimeout(res, 400));
  check(received.length >= 1, `钉钉收到 ${received.length} 条消息`);
  const text = received[0] && received[0].text && received[0].text.content;
  check(text === `张三抽中${drawn.record.prizeName}${drawn.record.amount}份`, `文案正确（含数量）：「${text}」`);

  r = await api('/api/admin/state');
  const pAfter = r.data.prizes.find((p) => p.name === drawn.record.prizeName);
  // 扣减量 = 该奖品的每次发放数量（帆布袋 perDraw=2 时抽一次扣 2 件）
  check(
    pAfter.awarded === drawn.record.amount && pAfter.stock === pAfter.initial - drawn.record.amount,
    `库存已扣减：${pAfter.stock}/${pAfter.initial}，已发放 ${pAfter.awarded}（每次 ${drawn.record.amount} 件）`,
  );

  console.log('\n=== 7. 抽完后显示已抽奖，且不能再抽 ===');
  await wait(1600);
  await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  await wait(1600);
  await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  await wait(500);

  r = await api('/api/admin/state');
  const zs = r.data.participants.find((p) => p.name === '张三');
  check(zs && zs.left === 0 && zs.status === 'done', `张三已抽完（used=${zs && zs.used}/${zs && zs.chances}，状态=${zs && zs.status}）`);

  await wait(1600);
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  check(r.status === 403 && r.data.code === 'NO_CHANCE', '次数用完后再抽被拒绝（NO_CHANCE）');

  console.log('\n=== 8. 追加次数后可继续抽 ===');
  const pid = zs.id;
  r = await api(`/api/admin/participants/${pid}`, { method: 'PATCH', body: JSON.stringify({ addChances: 1 }) });
  check(r.data.participant.left === 1, '追加 1 次 → 剩余 1');
  await wait(1600); // 绕过 1.5s 防连点
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '张三' }) });
  check(r.status === 200, `继续抽奖成功，抽中「${r.data.record && r.data.record.prizeName}」`);

  console.log('\n=== 9. 库存发完后的行为 ===');
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'all' }) });
  await api('/api/admin/prizes/import', {
    method: 'POST',
    body: JSON.stringify({ rows: [{ name: '唯一奖品', stock: 2, perDraw: 2 }], mode: 'replace' }),
  });
  await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '王五', chances: 3 }) });
  await new Promise((res) => setTimeout(res, 1600));
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '王五' }) });
  check(r.status === 200 && r.data.prize.remainingWins === 0, '抽完后该奖品剩余可抽次数为 0');
  const segsAfter = (await api('/api/wheel')).data.segments;
  check(segsAfter.length === 0, '无库存的奖品自动移出转盘');
  await new Promise((res) => setTimeout(res, 1600));
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '王五' }) });
  check(r.status === 409 && r.data.code === 'NO_STOCK', '无库存时返回 NO_STOCK，且不消耗次数');

  r = await api('/api/admin/state');
  const ww = r.data.participants.find((p) => p.name === '王五');
  check(ww.left === 2, `无库存不扣次数，王五仍剩余 ${ww.left} 次`);

  console.log('\n=== 10. 防连点与非法输入 ===');
  await api('/api/admin/prizes', { method: 'POST', body: JSON.stringify({ name: '测试', stock: 100, perDraw: 1 }) });
  await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ name: '赵六', chances: 5 }) });
  await new Promise((res) => setTimeout(res, 1600));
  await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '赵六' }) });
  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '赵六' }) });
  check(r.status === 429, '1.5 秒内重复抽奖被限流');

  r = await api('/api/draw', { method: 'POST', body: JSON.stringify({ name: '   ' }) });
  check(r.status === 400 && r.data.code === 'NAME_REQUIRED', '空姓名被拒绝');

  r = await api('/api/admin/prizes', { method: 'POST', body: JSON.stringify({ name: '', stock: 1, perDraw: 1 }) });
  check(r.status === 400, '空礼品名被拒绝');

  console.log('\n=== 11. 导出 CSV ===');
  const csv = await fetch(BASE + '/api/admin/export', { headers: { 'x-admin-token': token } });
  const csvText = await csv.text();
  check(csv.status === 200 && csvText.includes('姓名') && csvText.includes('奖品'), 'CSV 导出包含表头与数据');

  console.log(`\n=== 完成：mock 共收到 ${received.length} 条钉钉消息 ===`);
  received.forEach((m, i) => console.log(`  ${i + 1}. ${m.text ? m.text.content : JSON.stringify(m)}`));

  mock.close();
  console.log('\n' + (process.exitCode ? '存在失败用例 ✗' : '全部用例通过 ✓') + '\n');
})();

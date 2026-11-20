'use strict';
/**
 * 转盘几何与动画的无头验证
 * 用假的 CanvasRenderingContext2D 跑一遍 draw()，再验证 spinTo 后指针确实落在目标扇区
 */
const path = require('path');

const calls = [];
const gradient = { addColorStop() {} };
const ctx = new Proxy({}, {
  get(_t, k) {
    if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return () => gradient;
    if (k === 'measureText') return (s) => ({ width: String(s).length * 12 });
    if (typeof k === 'symbol') return undefined;
    if (k === 'canvas') return canvas;
    return (...a) => { calls.push([k, ...a]); };
  },
  set() { return true; },
});

const canvas = {
  getContext: () => ctx,
  clientWidth: 600,
  width: 0,
  height: 0,
  parentElement: null,
};

global.window = global;
global.devicePixelRatio = 2;
global.performance = { now: () => Date.now() };
global.addEventListener = () => {};
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 8);

require(path.join(__dirname, '..', 'public', 'js', 'wheel.js'));

const SEGS = [
  { id: 'a', name: 'AirPods Pro' },
  { id: 'b', name: '保温杯' },
  { id: 'c', name: '100元购物卡' },
  { id: 'd', name: '定制帆布袋' },
  { id: 'e', name: '蓝牙音箱' },
  { id: 'f', name: '谢谢参与' },
];

let ticks = 0;
const w = new window.Wheel(canvas, { onTick: () => { ticks += 1; } });
calls.length = 0; // 清掉构造时空转盘的占位绘制
w.setSegments(SEGS);
calls.length = 0;
w.draw();

let fail = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fail += 1;
};

console.log('\n=== 画布参数 ===');
check(canvas.width === 1200 && canvas.height === 1200, `按 dpr=2 放大画布：${canvas.width}x${canvas.height}`);
check(calls.length > 100, `draw() 产生了 ${calls.length} 次绘制调用`);

const arcs = calls.filter((c) => c[0] === 'arc' && c[3] > 200);
check(arcs.length >= 6, `绘制了 ${arcs.length} 个扇区/圆环弧线`);
const texts = calls.filter((c) => c[0] === 'fillText');
check(texts.length === 6, `绘制了 ${texts.length} 个奖品文字`);
check(texts.some((t) => String(t[1]).includes('AirPods')), '文字内容正确写入：' + texts.map((t) => t[1]).join(' / '));

console.log('\n=== indexAt 与扇区划分 ===');
const n = SEGS.length;
const seg = (Math.PI * 2) / n;
// 让每个扇区中心正对指针，验证映射
let okAll = true;
for (let i = 0; i < n; i += 1) {
  const rotation = -(i + 0.5) * seg;
  const idx = w.indexAt(rotation);
  if (idx !== i) { okAll = false; console.log(`    扇区 ${i} 反查得到 ${idx}`); }
}
check(okAll, `${n} 个扇区中心对齐指针时下标全部正确`);
check(w.indexAt(0) === 0, '初始角度（0）指针指向第 0 个扇区');

console.log('\n=== spinTo 落点验证 ===');
(async () => {
  for (const target of [0, 2, 5, 3]) {
    const before = ticks;
    const r0 = w.rotation;
    await w.spinTo(target, { turns: 2, duration: 120 });
    const landed = w.indexAt(w.rotation);
    const moved = w.rotation - r0;
    check(landed === target, `spinTo(${target}) 停在第 ${landed} 个扇区（转过的弧度 ${moved.toFixed(2)}）`);
    check(moved > Math.PI * 2, `至少转了 2 圈以上`);
    check(ticks > before, `转动过程触发了滴答回调 ${ticks - before} 次`);
  }

  console.log('\n=== 现金扇区：面积等分，与概率解耦 ===');
  // 即便传入 weight（概率），扇区也必须等分；中奖概率由服务端独立决定，与面积无关
  const WEIGHTED = [
    { id: 'a', name: '100元', weight: 10 },
    { id: 'b', name: '50元', weight: 20 },
    { id: 'c', name: '谢谢参与', weight: 70 },
  ];
  w.setSegments(WEIGHTED);
  const TAU2 = Math.PI * 2;
  const evenArc = TAU2 / WEIGHTED.length;
  let evenOk = true;
  for (let i = 0; i < WEIGHTED.length; i += 1) {
    const mid = -Math.PI / 2 + evenArc * (i + 0.5);
    if (w.indexAt(-Math.PI / 2 - mid) !== i) evenOk = false;
  }
  check(evenOk, '传入 weight 也强制等分：各扇区中心均能正确反查下标');
  check(w.indexAt(-evenArc * 0.2) === 0, '累计 20% 处落在第 0 个扇区（等分，不再按概率）');
  check(w.indexAt(-evenArc * 1.2) === 1, '累计 120% 弧长处落在第 1 个扇区');
  for (const target of [0, 1, 2]) {
    await w.spinTo(target, { turns: 1, duration: 80 });
    check(w.indexAt(w.rotation) === target, `等分扇区 spinTo(${target}) 准确落点`);
  }
  calls.length = 0;
  w.draw();
  const evenArcs = calls.filter((c) => c[0] === 'arc' && c[3] > 200 && c[4] !== undefined);
  check(evenArcs.length >= 3, '等分扇区绘制无异常');

  console.log('\n=== 边界情况 ===');
  w.setSegments([]);
  const empty = w.indexAt(0);
  check(empty === -1, '无奖品时 indexAt 返回 -1');
  const p = w.spinTo(0, { duration: 60 });
  check(p instanceof Promise, '无奖品时 spinTo 安全返回');

  w.setSegments(SEGS.slice(0, 4));
  await w.spinTo(1, { turns: 1, duration: 80 });
  check(w.indexAt(w.rotation) === 1, '扇区数量变化后仍能准确落点');

  console.log('\n' + (fail ? `存在 ${fail} 项失败 ✗` : '转盘逻辑全部通过 ✓') + '\n');
  process.exit(fail ? 1 : 0);
})();

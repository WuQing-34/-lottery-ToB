/**
 * 把项目源码内嵌进一个离线可看的 IDE 风格 HTML。
 * 用法：node scripts/build-codeview.js [输出路径]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, '..', '源码浏览.html');
const TPL = path.join(__dirname, 'codeview-template.html');

// 收录的源码文件（不含文档、锁文件、二进制与依赖）
const INCLUDE = [
  'package.json',
  'server/bus.js',
  'server/cash.js',
  'server/dingtalk.js',
  'server/index.js',
  'server/lottery.js',
  'server/report.js',
  'server/store.js',
  'public/index.html',
  'public/lottery.html',
  'public/cash.html',
  'public/admin.html',
  'public/css/style.css',
  'public/js/audio.js',
  'public/js/draw.js',
  'public/js/wheel.js',
  'public/js/admin.js',
  'public/js/cash-draw.js',
  'public/js/admin-cash.js',
  'scripts/gen_audio.py',
  'scripts/test-flow.js',
  'scripts/test-team.js',
  'scripts/test-cash.js',
  'scripts/test-wheel.js',
  'deploy/deploy.sh',
  'deploy/upload.sh',
  'deploy/lottery.service',
];

const LANG = {
  js: 'js', json: 'json', html: 'html', css: 'css',
  sh: 'sh', py: 'py', md: 'md', service: 'conf',
};

const files = {};
for (const rel of INCLUDE) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.warn('[skip] 不存在: ' + rel);
    continue;
  }
  let text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const ext = rel.split('.').pop().toLowerCase();
  files[rel] = {
    content: text,
    lang: LANG[ext] || 'text',
    size: Buffer.byteLength(text, 'utf8'),
    lines: text.split('\n').length,
  };
}

const json = JSON.stringify(files).replace(/<\//g, '<\\/'); // 防止 </script> 截断
const html = fs.readFileSync(TPL, 'utf8').replace('__SOURCE_DATA__', json);
if (html.includes('__SOURCE_DATA__')) throw new Error('模板占位符未替换');
fs.writeFileSync(OUT, html, 'utf8');

const count = Object.keys(files).length;
const lines = Object.values(files).reduce((a, f) => a + f.lines, 0);
console.log('生成: ' + OUT);
console.log('文件: ' + count + ' 个 / ' + lines + ' 行 / ' + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1) + ' KB');

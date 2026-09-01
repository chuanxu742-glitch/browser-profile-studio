import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf-8');
const js = readFileSync('public/app.js', 'utf-8');

// 匹配所有 document.getElementById('xxx')
const idRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
const jsIds = new Set();
let match;
while ((match = idRegex.exec(js)) !== null) {
  jsIds.add(match[1]);
}

console.log(`🔍 JS 中一共使用了 ${jsIds.size} 个 document.getElementById:`);
const missingIds = [];
for (const id of jsIds) {
  if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
    missingIds.push(id);
    console.log(`❌ 缺失 ID: ${id}`);
  }
}

if (missingIds.length === 0) {
  console.log('✅ 所有 document.getElementById 引用的 ID 在 HTML 中均 100% 存在！');
} else {
  console.log(`⚠️ 发现 ${missingIds.length} 个在 HTML 中不存在的 ID！这些会导致 JS 抛出 null 异常并中断所有后续事件绑定！`);
}

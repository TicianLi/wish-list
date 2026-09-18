/* 验证 daily-refresh.mjs 的「上限哨兵」计数逻辑：countRealTagNodes
   必须排除 Steam 自带的 `+` 占位符，否则每天误报"疑似截断"。
   做法：把函数从源码里抠出来（它只依赖 stripHtml），在 Node 里直接跑真实片段。
   这是本机唯一能验证这类逻辑的方式 —— 本机连不上 store.steampowered.com。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CI = fs.readFileSync(path.join(ROOT, 'tools', 'daily-refresh.mjs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

/* ---- 从源码里抠出依赖：stripHtml / TAG_BLOCK_RE / REAL_TAG_NODE_RE / 两个函数 ---- */
function grabFn(name) {
  const re = new RegExp('^(?:function\\s+' + name + ')' + '[\\s\\S]*?\\n\\}', 'm');
  const m = CI.match(re);
  if (!m) throw new Error('抠不到函数 ' + name);
  return m[0];
}
function grabConst(name) {
  const re = new RegExp('^const\\s+' + name + '\\s*=[^\\n]*;', 'm');
  const m = CI.match(re);
  if (!m) throw new Error('抠不到常量 ' + name);
  return m[0];
}
const sandboxSrc = [
  grabConst('TAG_BLOCK_RE'),
  grabConst('REAL_TAG_NODE_RE'),
  grabFn('stripHtml'),
  grabFn('countRealTagNodes'),
  grabFn('parseUserTags'),
  'module.exports = { stripHtml, countRealTagNodes, parseUserTags, REAL_TAG_NODE_RE };'
].join('\n\n');
const mod = { exports: {} };
new Function('module', 'exports', sandboxSrc)(mod, mod.exports);
const { countRealTagNodes, parseUserTags } = mod.exports;

console.log('=== 1. stripHtml / countRealTagNodes 抠取成功 ===');
check('1-1 抠出 countRealTagNodes', typeof countRealTagNodes === 'function');
check('1-2 抠出 parseUserTags', typeof parseUserTags === 'function');

/* ---- 真实片段：20 个标签 + 1 个 + 占位符（run #28 实测形态） ---- */
const real20 = Array.from({ length: 20 }, (_, i) =>
  `<a href="https://store.steampowered.com/tags/zh-cn/t${i}/" class="app_tag">标签${i}</a>`).join('\n');
const placeholder = '<a class="app_tag" style="display:none;">+</a>';
const page21 = real20 + '\n' + placeholder;

console.log('\n=== 2. 计数：必须排除 + 占位符 ===');
check('2-1 21 个节点（20 真实 + 1 占位）→ 计数 20', countRealTagNodes(page21) === 20, 'got ' + countRealTagNodes(page21));
check('2-2 只有占位符 → 计数 0', countRealTagNodes(placeholder) === 0, 'got ' + countRealTagNodes(placeholder));
check('2-3 空串 → 计数 0', countRealTagNodes('') === 0);
check('2-4 无 app_tag → 计数 0', countRealTagNodes('<div>hello</div>') === 0);
check('2-5 恰好 20 个真实标签 → 计数 20', countRealTagNodes(real20) === 20);

console.log('\n=== 3. 与 parseUserTags 严格一致（哨兵才不会误报）===');
check('3-1 21 节点页面：解析 20 == 计数 20',
  parseUserTags(page21).length === countRealTagNodes(page21),
  parseUserTags(page21).length + ' vs ' + countRealTagNodes(page21));
check('3-2 只有占位符：解析 0 == 计数 0',
  parseUserTags(placeholder).length === countRealTagNodes(placeholder));
check('3-3 空页面：解析 0 == 计数 0', parseUserTags('').length === countRealTagNodes(''));

console.log('\n=== 4. 超越 20 的页面（证明我们没有硬上限）===');
const real35 = Array.from({ length: 35 }, (_, i) =>
  `<a href="/tags/${i}/" class="app_tag">T${i}</a>`).join('') + placeholder;
check('4-1 35 个真实标签 → 解析 35（不再卡在 20）', parseUserTags(real35).length === 35,
  'got ' + parseUserTags(real35).length);
check('4-2 哨兵计数同为 35 → 不误报', countRealTagNodes(real35) === 35, 'got ' + countRealTagNodes(real35));

console.log('\n=== 5. 新游戏首次抓取（2 个标签）不该被判为截断 ===');
const two = '<a class="app_tag">动作</a><a class="app_tag">独立</a>' + placeholder;
check('5-1 解析 2 == 计数 2', parseUserTags(two).length === 2 && countRealTagNodes(two) === 2);

console.log('\n=== 6. 源码层面：哨兵接线正确 ===');
check('6-1 enrichStoreData 用 countRealTagNodes（不是裸 match）',
  /const rawN = countRealTagNodes\(html\);/.test(CI));
check('6-2 不再有旧的裸 match class="..."app_tag 计数',
  !/stat\.rawTagNodes = \(stat\.rawTagNodes \|\| 0\) \+ \(html\.match\(/.test(CI));
check('6-3 parseUserTags 源码里没有任何数量上限',
  !/tags\.length >= \d+/.test(CI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')));
check('6-4 占位符过滤仍在（t === "+" 判断）', /t === '\+'/.test(CI));

console.log('\n============================');
console.log('SENTINEL PASS ' + pass + '  FAIL ' + fail);
console.log('============================');
process.exit(fail ? 1 : 0);

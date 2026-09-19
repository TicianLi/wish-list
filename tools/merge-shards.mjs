/* 分片汇总合并（2026-09-19）
   ------------------------------------------------------------------
   背景：为了扛住"一千款一万款"，刷新被拆成 N 个并行 job，各自把
        自己那片的结果写到 data/_shards/<i>.json。本脚本负责：
          1. 读回全量 data/wishlist.json（作为权威基底）
          2. 读所有分片文件
          3. **按 appid 精确合并**：分片里的款覆盖基底里同 appid 的款，
             基底里没被任何分片覆盖的款**原样保留**
          4. 自检：所有分片合起来必须恰好覆盖全量（无遗漏、无重复），
             否则**报错退出**（绝不静默丢数据）
          5. 写回 data/wishlist.json

   用法： node tools/merge-shards.mjs
   环境： SHARD_TOTAL 期望的分片数（0/未设 = 自动发现 _shards 目录）

   ⚠ 这是"去上限"原则在分片上的落地：分片只是并行化手段，
     绝不能因为分片而让任何一款游戏被漏掉。
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'wishlist.json');
const SHARD_DIR = path.join(ROOT, 'data', '_shards');

const log = (...a) => console.log('[merge]', ...a);
const die = (msg) => { console.error('[merge] ✘ ' + msg); process.exit(1); };

if (!fs.existsSync(DATA_FILE)) die('找不到 ' + path.relative(ROOT, DATA_FILE));
const base = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
if (!base || !Array.isArray(base.games)) die('data/wishlist.json 缺少 games 数组');

if (!fs.existsSync(SHARD_DIR)) {
  log('没有分片目录 data/_shards/ —— 说明本次是单 job 模式，无需合并。');
  process.exit(0);
}

const files = fs.readdirSync(SHARD_DIR).filter(f => /^\d+\.json$/.test(f)).sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
if (!files.length) { log('分片目录为空，无需合并。'); process.exit(0); }

const expected = Number(process.env.SHARD_TOTAL || 0);
log(`发现 ${files.length} 个分片文件：${files.join(', ')}`);

/* ---- 1. 读入所有分片，并检查序号连续、无重复 ---- */
const shards = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(SHARD_DIR, f), 'utf8'));
  if (!Array.isArray(j.games)) die(`分片 ${f} 缺少 games 数组`);
  shards.push(j);
}
if (expected > 0 && shards.length !== expected) {
  die(`分片数不符：期望 ${expected} 个，实际 ${shards.length} 个。` +
      `多半是有分片 job 失败/超时（缺失的分片）。请检查 Actions 日志后重跑。`);
}

/* ---- 2. 按 appid 建立合并映射 ---- */
const baseById = new Map();
for (const g of base.games) {
  if (g && g.appid != null) baseById.set(Number(g.appid), g);
}

const merged = new Map();       // appid -> game（来自分片的新数据）
const dupAcross = [];           // 跨分片重复（说明切片逻辑出错）
for (const j of shards) {
  for (const g of j.games) {
    if (!g || g.appid == null) continue;
    const id = Number(g.appid);
    if (merged.has(id)) dupAcross.push(id);
    merged.set(id, g);
  }
}

if (dupAcross.length) {
  die(`检测到 ${dupAcross.length} 个 appid 被多个分片重复刷新（切片逻辑有误）：` +
      dupAcross.slice(0, 10).join(', '));
}

/* ---- 3. 把分片结果覆盖回基底（基底里没被覆盖的原样保留） ---- */
let updated = 0, added = 0, untouched = 0;
for (const [id, g] of merged) {
  if (baseById.has(id)) { baseById.set(id, g); updated++; }
  else { baseById.set(id, g); added++; }
}
untouched = base.games.length - updated;

/* ---- 4. 自检：合并结果不能比原清单"少" ---- */
const before = base.games.length;
const after = baseById.size;
if (after < before) {
  die(`合并后款数变少（${before} → ${after}），这绝不允许！疑似分片覆盖异常。`);
}

/* ---- 5. 顺序保持：按原清单顺序输出，新出现的补在末尾 ---- */
const ordered = [];
const seen = new Set();
for (const g of base.games) {
  const id = Number(g.appid);
  if (baseById.has(id) && !seen.has(id)) { ordered.push(baseById.get(id)); seen.add(id); }
}
for (const [id, g] of baseById) {
  if (!seen.has(id)) { ordered.push(g); seen.add(id); }
}

/* ---- 6. 写回 ---- */
const payload = {};
for (const k of Object.keys(base)) payload[k] = base[k];
payload.updatedAt = Date.now();
payload.refreshedAt = Date.now();
payload.refreshedBy = 'github-actions-merged';
payload.games = ordered;

fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');

/* ---- 7. 清掉分片目录（避免下次误合并旧数据） ---- */
for (const f of files) { try { fs.unlinkSync(path.join(SHARD_DIR, f)); } catch (e) { /* ignore */ } }
try { fs.rmdirSync(SHARD_DIR); } catch (e) { /* 非空就算了 */ }

log(`✔ 合并完成：更新 ${updated} 款，新增 ${added} 款，未触及 ${untouched} 款；` +
    `合并前后款数 ${before} → ${ordered.length}（必须相等或更多）。`);
if (before !== ordered.length) {
  log(`⚠ 注意：款数从 ${before} 变为 ${ordered.length}（差额来自分片里出现的新款）。`);
}

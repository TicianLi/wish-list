#!/usr/bin/env node
/**
 * tools/fetch-owned.mjs
 * ---------------------------------------------------------------
 * 【新增 2026-10-11】我的 Steam 库 —— 后端采集器
 *
 * 职责：调用 Steam Web API 的 GetOwnedGames，把「我库里有哪些游戏」
 *      写进 data/owned.json，供页面「已购待清理」区块比对用。
 *
 * 【为什么必须走 CI，不能在浏览器里直接调】
 *   1. 浏览器直连 api.steampowered.com 会被 CORS 挡住（返回 Failed to fetch，
 *      跟 GitHub API 那个老问题一模一样）；
 *   2. API Key 绝不能出现在前端代码里 —— 前端是公开仓库，一眼就能看到。
 *   所以：Key 只存在 GitHub Secrets，CI 用它调，页面只读产出的 json。
 *
 * 【只存 AppID，不存游戏名】——两个理由：
 *   1. 体积：181 款只有 appid 时 json 约 20KB，带名字会大好几倍，
 *      而 data/wishlist.json 已经 2.6MB 了；
 *   2. 隐私：这是**公开仓库**，谁都能看到我的库里有什么。名字没有必要暴露。
 *      页面要显示名字时，直接从本机清单里取 —— 交集项必然在本机清单中。
 *
 * 【铁律】
 *   1. 绝不打日志里的 Key / SteamID（日志会进 Actions 页面，可能被翻到）。
 *   2. 隐私设置不对（response.success === false）→ 写明确的 error 码，
 *      **退出码仍为 0**，绝不拖垮主线。
 *   3. 没有配置 Key → 直接跳过，不报错（用户可能不想开这个功能）。
 *
 * 运行：node tools/fetch-owned.mjs
 *
 * 必需环境变量：
 *   STEAM_API_KEY   Steam Web API Key（仓库 Secret）
 *   STEAM_ID64      17 位 SteamID64（仓库 Secret）
 * 可选：
 *   OWNED_PAGE_SIZE(2000)  每页条数（接口上限 2000）
 *   OWNED_MAX_PAGES(5)     最多翻几页
 *   OWNED_ENABLED(true)    总开关
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OWNED_FILE = path.join(ROOT, 'data', 'owned.json');

const CFG = {
  key: process.env.STEAM_API_KEY || '',
  steamId: process.env.STEAM_ID64 || '',
  pageSize: Math.min(2000, Number(process.env.OWNED_PAGE_SIZE || 2000)),
  maxPages: Number(process.env.OWNED_MAX_PAGES || 5),
  enabled: String(process.env.OWNED_ENABLED || 'true') !== 'false',
  timeoutMs: Number(process.env.REQ_TIMEOUT_MS || 20000),
};

function log(s) { console.log('[owned] ' + s); }
function warn(s) { console.log('[owned] ⚠ ' + s); }

/* 脱敏：日志里绝不出现完整 Key / SteamID。
   只显示前 4 位，后面用星号 —— 足够自己辨认，又不泄密。 */
export function maskSecret(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '(空)';
  if (s.length <= 4) return '****';
  return s.slice(0, 4) + '*'.repeat(Math.min(8, s.length - 4));
}

let net = null;
async function getNet() {
  if (net) return net;
  const mod = await import('./daily-refresh.mjs');
  net = { fetchJSON: mod.fetchJSON };
  return net;
}

/* SteamID64 必须是 17 位纯数字，且落在合法区间（SteamID64 = 76561197960265728 + accountId） */
export function isValidSteamId64(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (!/^\d{17}$/.test(t)) return false;
  const n = Number(t);
  const BASE = 76561197960265728n;
  const id = BigInt(t);
  return id >= BASE && id < BASE + 4294967296n;
}

/* 把 API 响应规整成 { ok, error, games }。
   纯函数，便于测试断言各种异常分支。 */
export function normalizeResponse(json) {
  const r = json && json.response;
  if (!r) return { ok: false, error: 'BAD_RESPONSE', games: [] };
  /* response.success === false 是 Steam 表达「隐私设置不让看」的方式，
     它不会给更具体的错误码 —— 这里必须翻译成人能看懂的话。 */
  if (r.success === false) return { ok: false, error: 'PRIVATE_PROFILE', games: [] };
  const arr = Array.isArray(r.games) ? r.games : [];
  const games = [];
  for (const g of arr) {
    const appid = Number(g && g.appid);
    if (!appid || appid <= 0) continue;
    /* ⚠️ 【2026-10-11 收紧】这个文件要进公开仓库（Pages 要读它页面才能工作），
       所以只保留**页面真正用到**的两个字段。
       被砍掉的 playtimeWindows / lastPlayed 是「指纹级」信息：
       「appid 730 游玩 30559 分钟、最后玩到某天」这种组合足以让人反查是谁的库，
       而页面一个都没用到（只用时长做「玩过 / 没玩过」的可信度判断）。
       少存一个字段就少一条能认出你的线索，这不是过度谨慎。 */
    games.push({
      appid,
      playtimeForever: Number(g.playtime_forever) || 0,
    });
  }
  games.sort((a, b) => (b.playtimeForever - a.playtimeForever) || (a.appid - b.appid));
  return { ok: true, error: null, games };
}

/* ★ 已拥有 / 是否玩过 的判定（纯函数，被测试直接断言）
   【2026-10-11 用户定，原语义已废弃】
   旧注释写的是「光凭在库里绝不能断定我买过」，于是 0 小时被标成 uncertain，
   页面显示成「⚠ 可能是评测密钥 / 赠送」并要用户逐条确认。
   用户原话：「我只要有的游戏都算，我有的我买它干什么呢」——
   **只要这个 AppID 出现在你的 Steam 库里，对你来说就已经是「你有」**。
   借来的、赠送的、免费领取的照样是「你能玩」，那是你的东西，不是「疑似」。

   所以现在它只回答一件事：**你玩过没有**（纯展示用）。
   名字沿用 likely/uncertain 是为了不动测试契约与页面数据形状 ——
   但语义已经变成「玩过 / 没玩过」，**不再是可信度分档，也不会拦着你删**。 */
export function judgeOwnership(playtimeForever) {
  const h = Number(playtimeForever) || 0;
  if (h > 0) return 'likely';   // 玩过
  return 'uncertain';           // 没玩过（≠ 可能没有）
}

function writeOut(payload) {
  try {
    fs.mkdirSync(path.dirname(OWNED_FILE), { recursive: true });
    fs.writeFileSync(OWNED_FILE, JSON.stringify(payload, null, 1));
    return true;
  } catch (e) {
    warn('写 data/owned.json 失败：' + (e && e.message));
    return false;
  }
}

export async function main() {
  const now = Date.now();

  if (!CFG.enabled) { log('OWNED_ENABLED=false —— 跳过'); return { skipped: true }; }

  if (!CFG.key) {
    log('未配置 STEAM_API_KEY —— 跳过本功能（这是正常的，不是错误）');
    // 不写文件，保留上次的旧数据
    return { skipped: true, reason: 'NO_KEY' };
  }
  if (!isValidSteamId64(CFG.steamId)) {
    warn('STEAM_ID64 缺失或格式不对（应为 17 位数字）—— 跳过。收到的值：' + maskSecret(CFG.steamId));
    return { skipped: true, reason: 'BAD_STEAMID' };
  }

  log(`Key=${maskSecret(CFG.key)} SteamID=${maskSecret(CFG.steamId)}`);

  const n = await getNet();
  const all = [];
  let error = null;

  for (let p = 0; p < CFG.maxPages; p++) {
    const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/'
      + '?key=' + encodeURIComponent(CFG.key)
      + '&steamid=' + encodeURIComponent(CFG.steamId)
      + '&include_appinfo=0'
      + '&include_played_free_games=1'   // 含免费领取的，否则领过的游戏查不到
      /* 【2026-10-11 补】include_family_licenses —— 必须带，否则家庭共享的 games 会**整批漏掉**。
         GetOwnedGames 默认只返回「你自己拥有」的游戏；家庭组（Family Sharing）里别人买、
         你可玩的那部分，要显式开这个参数才会返回，且每条带 family_shared 标记。
         不带的症状很隐蔽：页面照常工作，只是「已购检测」把你的家人共享游戏漏判成「未购买」，
         你会以为功能坏了 —— 实际上是采集面窄了，不是判定逻辑错。

         ⚠️ 已知副作用（Steam 行为，不是 bug）：家庭共享游戏的 playtime_forever 基本都是 0
         （时长归属账号所有者）。因此它们会落进 uncertain（= 没玩过）桶 ——
         但按用户定的语义，**它们同样是「你已拥有」**，页面会照常列出来，只标注「未游玩」。 */
      + '&include_family_licenses=1'
      + '&count=' + CFG.pageSize;
    let json;
    try {
      json = await n.fetchJSON(url, { retries: 3, timeoutMs: CFG.timeoutMs });
    } catch (e) {
      error = 'NETWORK: ' + (e && e.message);
      warn('请求失败：' + (e && e.message));
      break;
    }
    const r = normalizeResponse(json);
    if (!r.ok) { error = r.error; break; }
    all.push(...r.games);
    log(`第 ${p + 1}/${CFG.maxPages} 页：累计 ${all.length} 款`);
    if (r.games.length < CFG.pageSize) break;
  }

  if (error) {
    if (error === 'PRIVATE_PROFILE') {
      /* 说明：走到这里说明 Steam 明确回了 success=false，这才是隐私设置的问题。
         注意别搞反因果 —— 绝大多数人隐私本来就是公开的，接口照样调不通，
         因为浏览器直连会被 CORS 挡死（见文件头「为什么必须走 CI」）。
         这个分支只是兜底，别让人以为「不公开是常态」。 */
      warn('Steam 返回 success=false —— 你的 Steam 隐私设置里「游戏详情」不是公开的。');
      warn('  改法：Steam 客户端 → 设置 → 隐私 → 游戏详情 → 改为「公开」');
    }
    /* ⚠️ 【2026-10-11 修】失败时**绝不能用空数组覆盖已有数据**。
       旧实现写的是 count: all.length / games: all —— 请求失败时 all 往往是空的
       （或只有前几页），于是 CI 网络一抖、Steam 超时、限流退避耗尽，
       用户的整份已购库就被清空 → 页面把「所有游戏」都当成「库里没有」，
       已购检测彻底失灵，而且**没有任何报错提示**（error 字段只有内行才看得见）。

       这正是本机实测踩到的：node fetch 对 Steam 直接 fetch failed，
       第一次跑就把 181 款的 owned.json 写成了空壳。

       正确做法：失败时**读回旧文件、保留原 games**，只更新错误信息与时间戳。
       采集是"锦上添花"，抓不到就不该破坏已有的好数据。 */
    let prev = { games: [], count: 0 };
    try { prev = JSON.parse(fs.readFileSync(OWNED_FILE, 'utf8')) || prev; } catch (e2) { /* 没有旧文件就走空 */ }
    const keptGames = Array.isArray(prev.games) ? prev.games : [];
    writeOut({
      version: 1, fetchedAt: now,
      count: keptGames.length, games: keptGames,   // ← 保留旧数据，不清空
      uncertainCount: keptGames.filter(g => judgeOwnership(g.playtimeForever) === 'uncertain').length,
      error,
      errorHint: error === 'PRIVATE_PROFILE'
        ? '请到 Steam 设置 → 隐私 → 游戏详情 改成「公开」，然后重新运行。'
        : '本次抓取失败，已保留上一次的库数据（不受影响）；可点页面上的「重新检测」再试一次。',
    });
    // ★ 退出码保持 0
    return { count: keptGames.length, error };
  }

  // 去重
  const seen = new Set();
  const games = [];
  for (const g of all) { if (!seen.has(g.appid)) { seen.add(g.appid); games.push(g); } }
  const uncertain = games.filter(g => judgeOwnership(g.playtimeForever) === 'uncertain').length;

  writeOut({
    version: 1, fetchedAt: now, count: games.length, games, error: null,
    // 统计字段方便页面直接显示，不必自己算
    uncertainCount: uncertain,
  });

  log(`✅ 已写 data/owned.json：${games.length} 款（其中 ${uncertain} 款还没玩过，同样算你已拥有）`);
  return { count: games.length, uncertain };
}

/* ================================ 入口 ================================ */
function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
}
if (isDirectRun()) {
  main().catch(e => {
    warn('未预期异常（已忽略，不影响主流程）：' + (e && e.stack ? e.stack : e));
    try {
      writeOut({ version: 1, fetchedAt: Date.now(), count: 0, games: [], error: 'EXCEPTION: ' + String(e && e.message || e) });
    } catch (_) { /* 绝不抛 */ }
  });
}
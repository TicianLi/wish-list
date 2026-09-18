/* GitHub Contents API 部署小工具（重建版）
   用法：
     node deploy.mjs ls [前缀]              列出仓库文件
     node deploy.mjs push <本地> <仓库路径>  上传/更新单个文件（可多组）
     node deploy.mjs rm <仓库路径>          删除文件
     node deploy.mjs trigger [changes|always] 触发 workflow_dispatch
     node deploy.mjs runs                   列出最近 runs
     node deploy.mjs logtext <run_number>   打印某次 run 的日志文本
   铁律：一律 --noproxy '*' 直连；失败再试代理（系统代理会随机破坏 POST/PUT）
*/
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OWNER = 'TicianLi';
const REPO = 'wish-list';
const BRANCH = 'main';
const DATA_PATH = 'data/wishlist.json';
const CURL = 'C:/WINDOWS/system32/curl.exe';
const TOKEN_FILE = path.join(__dirname, '.secrets', 'gh_token.txt');

const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
if (!token) { console.error('缺少 Token：' + TOKEN_FILE); process.exit(2); }

function curl(args, useProxy) {
  const a = useProxy ? args : ['--noproxy', '*'].concat(args);
  const r = spawnSync(CURL, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/* 先直连 3 次，再走代理 2 次
   allowEmpty=true 时（如 workflow_dispatch 的 204）不要求 body 非空 */
function api(method, url, body, extraHeaders, allowEmpty) {
  const args = ['-sS', '-X', method, '-H', 'Authorization: Bearer ' + token,
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (extraHeaders) extraHeaders.forEach(h => args.push('-H', h));
  let tmp = null;
  if (body != null) {
    tmp = path.join(__dirname, '.secrets', '_body.json');
    fs.writeFileSync(tmp, body, 'utf8');
    args.push('--data-binary', '@' + tmp);
  }
  args.push(url);
  for (let i = 0; i < 3; i++) {
    const r = curl(args, false);
    if (r.status === 0 && (allowEmpty || r.out.trim())) return r.out;
  }
  for (let i = 0; i < 2; i++) {
    const r = curl(args, true);
    if (r.status === 0 && (allowEmpty || r.out.trim())) return r.out;
  }
  throw new Error('请求失败：' + method + ' ' + url);
}

const apiBase = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

function getSha(repoPath) {
  const out = api('GET', apiBase + '/contents/' + repoPath + '?ref=' + BRANCH);
  const j = JSON.parse(out);
  if (j && j.sha) return j.sha;
  return null;
}

function cmdLs(prefix) {
  const out = api('GET', apiBase + '/contents/' + (prefix || '') + '?ref=' + BRANCH);
  const j = JSON.parse(out);
  if (!Array.isArray(j)) { console.log(out.slice(0, 500)); return; }
  j.forEach(x => console.log((x.type === 'dir' ? '[D] ' : '    ') + x.path + '  ' + (x.size || '')));
}

function cmdPush(pairs) {
  for (let i = 0; i < pairs.length; i += 2) {
    const local = pairs[i], repoPath = pairs[i + 1];
    const buf = fs.readFileSync(local);
    const content = buf.toString('base64');
    const sha = getSha(repoPath);
    const body = JSON.stringify({
      message: 'chore: 更新 ' + repoPath, content, branch: BRANCH, ...(sha ? { sha } : {})
    });
    const out = api('PUT', apiBase + '/contents/' + repoPath, body);
    const j = JSON.parse(out);
    console.log('推送 ' + repoPath + ' → ' + (j.commit ? j.commit.sha.slice(0, 12) : JSON.stringify(j).slice(0, 200)));
  }
}

function cmdRm(repoPath) {
  const sha = getSha(repoPath);
  if (!sha) { console.log('远端不存在：' + repoPath); return; }
  const out = api('DELETE', apiBase + '/contents/' + repoPath,
    JSON.stringify({ message: 'chore: 删除 ' + repoPath, sha, branch: BRANCH }));
  const j = JSON.parse(out);
  console.log('已删除 ' + repoPath + ' → ' + (j.commit ? j.commit.sha.slice(0, 12) : ''));
}

function cmdTrigger(mode) {
  const body = JSON.stringify({ ref: BRANCH, inputs: { mail_mode: mode || 'changes' } });
  /* 注意：workflow_dispatch 成功返回的是 204 No Content（body 为空）。
     api() 默认要求"有输出才算成功"，这里必须放开 —— 否则明明触发了却报错。 */
  const out = api('POST', apiBase + '/actions/workflows/daily-refresh.yml/dispatches', body, null, true);
  console.log('已触发 workflow_dispatch（mail_mode=' + (mode || 'changes') + '）（HTTP 204 = 成功，无返回体）');
}

function cmdRuns() {
  const out = api('GET', apiBase + '/actions/runs?per_page=10');
  const j = JSON.parse(out);
  (j.workflow_runs || []).forEach(r => {
    console.log('#' + String(r.run_number).padStart(3) + '  ' + r.status + '/' + r.conclusion +
      '  ' + r.created_at + '  ' + r.head_commit.message.split('\n')[0].slice(0, 50));
  });
}

function cmdLogtext(runNumber) {
  const out = api('GET', apiBase + '/actions/runs?per_page=50');
  const j = JSON.parse(out);
  const run = (j.workflow_runs || []).find(r => String(r.run_number) === String(runNumber));
  if (!run) { console.log('找不到 run #' + runNumber); return; }
  const jobsOut = api('GET', apiBase + '/actions/runs/' + run.id + '/jobs');
  const jj = JSON.parse(jobsOut);
  (jj.jobs || []).forEach(job => {
    console.log('\n=== job: ' + job.name + ' (' + job.status + '/' + job.conclusion + ') ===');
    (job.steps || []).forEach(s => console.log('  ' + (s.conclusion || s.status).padEnd(10) + ' ' + s.name));
  });
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'ls') cmdLs(rest[0]);
  else if (cmd === 'push') cmdPush(rest);
  else if (cmd === 'rm') cmdRm(rest[0]);
  else if (cmd === 'trigger') cmdTrigger(rest[0]);
  else if (cmd === 'runs') cmdRuns();
  else if (cmd === 'logtext') cmdLogtext(rest[0]);
  else {
    console.log('用法：node deploy.mjs ls|push|rm|trigger|runs|logtext ...');
  }
} catch (e) {
  console.error('错误：' + e.message);
  process.exit(1);
}

# 每日凌晨 02:00 自动刷新 + QQ 邮件日报 · 部署指南

> 目标：每天**北京时间凌晨 02:00**，云端自动把你的愿望单价格/史低刷新一遍，
> 导出 JSON，并把日报发到你的 QQ 邮箱。你早上起来收邮件就行。

整条链路长这样：

```
你的浏览器（localStorage）
   │  ① 点「☁️ 同步到云端」（只需做一次 + 以后有改动时再做）
   ▼
仓库里的 data/wishlist.json        ← 云端副本
   │  ② 每天 02:00 GitHub Actions 自动触发
   ▼
tools/daily-refresh.mjs
   ├─ 逐个 AppID 重新抓 Steam 价格 / 评分
   ├─ （可选）查 ITAD 史低
   ├─ 写回 data/wishlist.json（保留你手填的目标价/备注）
   ├─ 导出快照 data/steam-wishlist-YYYY-MM-DD.json
   └─ ③ 邮件（JSON 作为附件）→ 你的 QQ 邮箱
```

---

## 第 0 步 · 前置检查

| 检查项 | 要求 |
| --- | --- |
| 仓库 | 已推到 GitHub（例如 `TicianLi/wish-list`），且开了 Pages |
| 文件 | 仓库里有 `tools/daily-refresh.mjs`、`.github/workflows/daily-refresh.yml`、`package.json` |
| 本地 | 已 `git push`（工作流文件必须在**默认分支**上才会被 schedule 触发） |

> ⚠️ **最容易踩的坑**：工作流文件必须在**默认分支**（通常是 `main`）。如果它只存在于别的分支，定时任务**永远不会跑**。

---

## 第 1 步 · 拿到 QQ 邮箱授权码

**这一步不能用 QQ 登录密码！** 必须用「授权码」。

1. 电脑浏览器打开并登录 [QQ 邮箱网页版](https://mail.qq.com)（用电脑版，手机 App 里没有这个设置）。
2. 顶部 **设置** → **账户**（或「账号」）标签页。
3. 往下找 **IMAP/SMTP 服务**（有的版本叫「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务」）。
4. 点击 **开启**，按提示**用手机发一条短信**到指定号码。
5. 短信发完，页面会给出一串 **16 位授权码**，形如 `abcdwxyzefghijkl`。
6. **立刻复制保存**（关掉页面就看不到了，丢了只能重新生成）。

> 这串授权码就是程序发信时的"密码"。它和你的登录密码是两个东西。

---

## 第 2 步 · 写进 GitHub Secrets

打开你的仓库页面：

**Settings → Secrets and variables → Actions → New repository secret**

逐个添加下面这些（**名字必须完全一致**，大小写敏感）：

| Name | Value | 必填 | 说明 |
| --- | --- | --- | --- |
| `SMTP_HOST` | `smtp.qq.com` | ✅ | QQ 邮箱的 SMTP 服务器 |
| `SMTP_PORT` | `465` | ✅ | **必须是 465**，不要用 587 |
| `SMTP_USER` | `你的QQ号@qq.com` | ✅ | 完整邮箱地址 |
| `SMTP_PASS` | 第 1 步拿到的**授权码** | ✅ | ⚠️ 不是登录密码 |
| `MAIL_TO` | 接收邮件的邮箱 | ✅ | 可以就是你自己 |
| `MAIL_FROM` | 发件显示名 | ⬜ | 不填则用 `SMTP_USER` |
| `ITAD_API_KEY` | [ITAD](https://isthereanydeal.com/apps/) 的 Key | ⬜ | 填了才查史低，不填就跳过 |

添加完，这个页面应该能看到 5～7 个 Secret（值都是隐藏的，只会显示名字）。

> 💡 `SMTP_PORT` 填了但填成 `587` 是最常见的失败原因——QQ 邮箱的 465 走 SSL，587 走 STARTTLS，脚本按 465 配置的。

---

## 第 3 步 · 给 Actions 写权限（否则提交会失败）

**Settings → Actions → General → 拉到最下面 Workflow permissions**

选 **`Read and write permissions`** → 点 **Save**。

> 不做的后果：刷新能跑完、邮件能发，但「把刷新后的数据提交回仓库」那一步会报 `Permission denied`。

---

## 第 4 步 · 把清单同步到云端

1. 打开你的网站，输入访问密钥进入。
2. 确认清单里有你想追踪的游戏（加游戏、设目标价、写备注）。
3. 点工具栏里的 **「☁️ 同步到云端」**。
   - 如果还没配过 Token，会**自动打开设置面板**并定位到「云端同步」区块。
4. 在 **设置 → ☁️ 云端同步** 里填写：

   | 字段 | 填什么 |
   | --- | --- |
   | **GitHub Token** | 下面教你生成 |
   | 仓库所有者 | 你的 GitHub 用户名，如 `TicianLi` |
   | 仓库名 | 如 `wish-list`（⚠️ 带连字符，别写成 `wishlist`） |
   | 分支 | 通常是 `main` |
   | 数据文件路径 | 保持 `data/wishlist.json` |

5. 点 **「测试连接」** —— 会告诉你 Token 能不能读到仓库、有没有写权限、分支对不对。
   绿灯了再点 **「保存并同步一次」**。
6. 成功后仓库里会出现 `data/wishlist.json`。

### 怎么生成 GitHub Token

1. 打开 <https://github.com/settings/personal-access-tokens/new>（Fine-grained token）。
2. **Token name**：随便填，比如 `wishlist-sync`。
3. **Expiration**：建议选 90 天或更长（过期后要回来重新生成）。
4. **Repository access**：选 **Only select repositories** → 勾选你的 `wish-list` 仓库。
   ⚠️ 这里一定要勾上，否则会 403。**如果新增了仓库，要回来把这个 Token 的授权范围补上。**
5. **Permissions → Repository permissions** → 找到 **Contents** → 设为 **Read and write**。
   ⚠️ 只给 Read 会 403；不用给其他任何权限。
6. 点 **Generate token**，复制那串 `github_pat_...`，粘到页面的 Token 框里。

> Token 只存在你本机浏览器 localStorage，不会上传到任何地方。

> 💡 **已经有一个 Token 了？** 如果它是 Classic（`ghp_` 开头），给公开仓库写数据只需要勾 `repo` 这一项。
> 如果它当初创建时**没勾这个仓库**，改范围不一定能补发权限——建议直接重新生成一个。

---

## 🔴 遇到 `HTTP 403: Resource not accessible by personal access token`

这是**最常见**的问题。含义是：**Token 没有写这个仓库的权限**。按顺序检查：

### ① 仓库范围没勾（最常见）

Token 设置里的 **Repository access** 必须是 `Only select repositories` 并勾上你的仓库，
或者选 `All repositories`。

**没勾的话，GitHub 对这个仓库一律返回 403，即使权限位设对了。**

### ② Contents 权限是只读

`Permissions → Repository permissions → Contents` 必须是 **Read and write**。

### ③ 仓库属于组织

如果仓库在某个组织下（不是个人账户），Fine-grained token 创建后还需要
**组织管理员批准**。去组织页面 → Settings → Personal access tokens → Pending requests → Approve。

### ④ 权限改了但没生效

权限修改后，**同一个 Token 会立即生效**，不用重新生成。
但如果当初创建时选错了仓库范围，**改范围不会补发权限**——建议直接重新生成一个。

### ⑤ 用页面的「测试连接」自查

设置 → 云端同步 → **测试连接**。它会明确告诉你卡在哪一环：

| 提示 | 含义 |
| --- | --- |
| ✅ 连接成功 | Token 正常，可以同步 |
| ⚠️ 但 Token 没有写入权限 | 命中上面的 ② |
| ⚠️ 你填的分支不是默认分支 | 分支名写错了 |
| HTTP 401 | Token 无效或过期，重新生成 |
| HTTP 404 | Token 看不到这个仓库，命中上面的 ① |

---

## 🔵 遇到 `云端同步失败：Failed to fetch`

**这一条和上面的 403 是两回事。** 403 是「GitHub 收到请求了，但拒绝你」；
`Failed to fetch` 是「请求**根本没发出去**」——浏览器在网络层就把请求拦掉了，
所以拿不到任何 HTTP 状态码。

> ✅ 只要看到 `Failed to fetch`，就**一定是网络/浏览器层的问题，不是 Token 权限问题**。
> 页面现在会直接把这句话翻译成人话，并提示你该查什么。

常见的三个原因：

| 原因 | 怎么确认 | 怎么解决 |
| --- | --- | --- |
| **① 网络/代理拦了 `api.github.com`** | 用手机热点试一次就知道 | 换网络，或开代理 |
| **② 浏览器扩展拦截**（广告拦截、隐私防护、脚本拦截类） | 换个浏览器 / 无痕模式试一次 | 关掉拦截类扩展，或把本站加白名单 |
| **③ 用 `file://` 直接打开了页面** | 看地址栏是不是 `file:///...` | 必须通过 `https://ticianli.github.io/wishlist/` 访问 |

### 🧪 一站式定位：`连通性自检.html`

如果上面三条试完还是不行，用这个自检页，它会**逐跳测一遍**并给出结论。

**用法**：把它和 `index.html` 放在**同一个目录**（已经在仓库里了），
用**和访问主页完全一样的方式**打开它：

```
https://ticianli.github.io/wishlist/连通性自检.html
```

然后点「开始自检」，它会依次测：

| 检测项 | 说明 |
| --- | --- |
| 页面协议 | 是不是 `https`（`file://` 会直接被点名） |
| 系统在线状态 | `navigator.onLine` |
| 能否发出请求 | 打到 `api.github.com/rate_limit`，测网络层通不通 |
| GitHub 服务状态 | 查 `githubstatus.com`，区分「全网不通」还是「只有你这边不通」 |
| 匿名配额 | 不带 Token 读一次，确认 API 真的能用 |
| 带 Token 读仓库 | 填了 Token 才会跑，进一步确认权限 |

最后给出一句**结论**，只会是下面三种之一：

- **「网络层被拦住了」** → 问题在原因 ①②③，跟 Token 无关，先解决网络/扩展。
- **「网络可达，但 Token 或仓库配置有问题」** → 问题在权限，回去看上面的 [🔴 403 排查](#-遇到-http-403-resource-not-accessible-by-personal-access-token)。
- **「一切正常」** → 那就可以正常用云端同步了。

> 📌 这个页面**不写任何数据**，只做只读探测，可以放心在别人的电脑上打开。
> 它也不会把你的 Token 发到除 `api.github.com` 以外的任何地方。

---

## 第 5 步 · 先手动跑一次验证

别等凌晨，先手动测：

**仓库 → Actions → 左侧选「每日凌晨自动刷新并邮件导出」→ 右侧 Run workflow → 选 `always` → 绿色 Run workflow**

等 1～3 分钟，跑完后：

1. **看日志**：点进这次运行，展开「执行刷新并发送邮件」，应该能看到：
   ```
   [时间] === Steam 愿望单 · 每日自动刷新 开始 ===
   [时间] 读取到 N 款游戏
   [时间]   1/N ✅ 游戏名 ¥价格 -折扣%
   ...
   [时间] 邮件已发送至 xxx@qq.com ✅
   [时间] === 完成 ===
   [时间] 收录 N｜刷新成功 N｜失败 0｜促销 N｜史低 N｜达标 N
   ```
2. **收邮件**：去 QQ 邮箱看有没有主题含「Steam 愿望单日报」的邮件，JSON 在附件里。
3. **看 Artifacts**：运行页面底部「Artifacts」里能下载 `wishlist-json-*` 压缩包。

### 如果失败了，对照下表

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `data/wishlist.json 不存在` | 第 4 步没做 | 回页面点「☁️ 同步到云端」 |
| **`HTTP 403: Resource not accessible`** | **Token 权限不足** | 见上面的 [🔴 403 排查](#-遇到-http-403-resource-not-accessible-by-personal-access-token) |
| **`Failed to fetch`** | **网络/浏览器层拦截**（不是权限） | 见上面的 [🔵 Failed to fetch](#-遇到-云端同步失败failed-to-fetch)，或跑 `连通性自检.html` |
| `邮件发送失败: Invalid login` | `SMTP_PASS` 填成了登录密码 | 换成 16 位授权码 |
| `邮件发送失败: Connection timeout` | 端口不是 465 | 改成 `465` |
| `Permission denied` / `403`（在 Actions 日志里） | 第 3 步没开写权限 | 回去开 `Read and write` |
| 完全没触发 | 工作流不在默认分支 | merge 到 `main` |
| 跑了但没邮件 | `MAIL_TO` 空 / 在垃圾箱 | 检查 Secret，翻垃圾邮件 |
| 刷新了但价格没变 | Steam 确实没变价 | 正常，不是 bug |

> 📌 **邮件发送失败不影响 JSON 导出和数据写回**，两者互相独立。所以日志里发信失败但数据提交成功，是正常的。

---

## 修改配置 / 换 Token

所有云端同步的配置都在页面 **设置 → ☁️ 云端同步** 里，可以随时改：

- **换 Token**：直接粘贴新的，点「保存并同步一次」。
- **清除 Token**：点「清除 Token」按钮（会二次确认）。
- **改仓库/分支/路径**：改完点「保存并同步一次」。
- 区块顶部会实时显示当前状态，比如
  `当前：已配置 · TicianLi/wishlist · 分支 main · Token github_pat…cdef`（Token 会自动打码）。

之前版本有个坑：Token 是弹窗一次性输入的，填错了没地方改。
现在改成设置面板里的常驻表单项了，随时能改。

---

## 第 6 步 · 之后就不用管了

配置好之后：

- 每天 **北京时间 02:00**（UTC 18:00）自动跑。
- 数据写回 `data/wishlist.json`，同时留一份当天快照。
- 日报邮件自动进你邮箱。

> ⏰ GitHub 的 schedule 在高峰期（整点附近）可能**排队延迟 5～15 分钟**，这是平台行为，不是脚本问题。

---

## 想调整？改这些地方

### 改发信频率（邮件太多）

只想**有变化时才发**：编辑 `.github/workflows/daily-refresh.yml`，把 `env:` 里的

```yaml
MAIL_MODE: ${{ github.event.inputs.mail_mode || 'always' }}
```

改成

```yaml
MAIL_MODE: changes
```

也可以不改文件——手动运行工作流时，在 `mail_mode` 下拉里选 `changes` 临时试一次。

### 改发送时间

cron 用 **UTC**，换算公式：`北京时间 - 8 小时 = UTC`。

| 你想的时间（北京） | cron |
| --- | --- |
| 02:00 | `0 18 * * *`（前一天） |
| 07:00 | `0 23 * * *`（前一天） |
| 09:00 | `0 1 * * *` |
| 21:00 | `0 13 * * *` |

改 `.github/workflows/daily-refresh.yml` 里的 `- cron: '...'`。

### 其他可调项

在 workflow 的 `env:` 里加（左列是变量名，右列是默认值）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STEAM_CC` | `cn` | 定价区，国区就是 `cn` |
| `STEAM_LANG` | `schinese` | 抓取名称/评论的语言 |
| `MAIL_MODE` | `always` | `always` 每天发 / `changes` 只在有变化时发 |
| `REQ_INTERVAL_MS` | `700` | 每个请求间隔，避免被 Steam 限流 |
| `REQ_TIMEOUT_MS` | `20000` | 单请求超时（毫秒） |
| `MAX_GAMES` | `0` | 每次最多刷新几款，`0` = 不限 |

---

## 哪些数据是安全的

刷新脚本**绝对不会覆盖**你手动填的东西：

- ✅ `targetPrice`（目标价）
- ✅ `note`（备注）
- ✅ `historicalLow.source === '手动确认'`（你手动确认过的史低）

另外，单个游戏抓取失败**不会影响整体**——它是跳过那一个，其他照常刷新，并在日志里标 ⚠️。

---

## 本地想先试试？

不想等云端，可以本地跑离线自测（不联网、不发真邮件，用假 Steam 服务走全流程）：

```bash
npm install          # 只需装 nodemailer
npm run selftest     # 期望输出 SELFTEST PASS 11  FAIL 0
```

想本地跑真实刷新（需要 `data/wishlist.json` 存在）：

```bash
# Windows PowerShell
$env:SMTP_HOST="smtp.qq.com"; $env:SMTP_PORT="465"
$env:SMTP_USER="你的QQ@qq.com"; $env:SMTP_PASS="授权码"
$env:MAIL_TO="你的QQ@qq.com"
npm run refresh
```

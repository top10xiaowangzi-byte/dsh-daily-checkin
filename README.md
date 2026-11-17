# dsh-daily-checkin（DeepSeek Harness 插件）

一个只装进 DeepSeek Harness 的签到插件：**DSH 启动时自动完成 WorkBuddy、WPS 灵犀、Qoder、MiniMax Code、码道 CodeArts 五家的每日签到/领取积分**，
并在会话标题栏显示签到入口与结果面板（失败项可重试）。

## 作用

- **启动自动签到**：DSH 启动时依次处理 WorkBuddy（国内版）、WPS 灵犀、Qoder、MiniMax Code、码道 CodeArts；各平台独立，一个失败不影响其它。
- **幂等**：今天已签到的只报告「已签到/已领取」，不会重复领取；跨天后第一次打开面板会自动补签当天。
- **跨天自动补签**：DSH 一直开着也会自己发现日期变了（每小时检查一次），当天自动重跑一轮，不用重启 DSH。
- **MiniMax 积分详情**：MiniMax 那一行除了「今天 +400 积分，第 1/7 天」，还会显示
  `积分余额 369.88 · 12/12 过期 · 明日 +400 · 本周期 1/7 天`。
- **标题栏面板**：会话标题栏出现签到图标 + 条目数 + 状态点（绿=全部成功、黄=部分失败、红=全部失败）。
  点开可看每个平台的连签/积分/奖励，失败项可一键重试。
- **登录态只读**：WorkBuddy / 灵犀 / Qoder / MiniMax 只读取本机客户端登录态，token/cookie 只在内存中使用，不落盘、不打印。
- **状态落盘**：`$DSH_HOME/.daily-checkin.json`（最近一次结果，供面板显示）。

## 五个平台的前置条件

| 平台 | 需要的本机条件 | 登录态来源 |
|---|---|---|
| WorkBuddy（国内版） | 安装并登录过 WorkBuddy | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` |
| WPS 灵犀 | 登录过 WPS 灵犀或 WPS Office | WPS Office CEF Cookie / 灵犀自己的 Cookie |
| Qoder | 登录过 Qoder CN 桌面版 | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat` |
| MiniMax Code | 登录过 MiniMax Code 桌面版（国内版 agent.minimax.cn） | `%USERPROFILE%\.mavis\auth\prod\cn\mcode-public\auth.json` |
| **码道 CodeArts** | **Node.js + Playwright（本机已装 `@playwright/cli` 即可，另需 `npx playwright install chromium`），并运行过一次「码道登录.cmd」** | Playwright 持久化 profile + `$DSH_HOME/codearts-session.json` |

Windows 是前提（WPS/Qoder 的登录态解密依赖 Windows DPAPI）；DSH 0.2.x 桌面/Web 运行环境（插件不 import 任何 `@deepseek-ai/*` 包）。

## 安装

```text
dsh plugin --profile <profile> add file:<本目录绝对路径>
```

或用 DSH 插件管理器「安装本地插件」选择本目录，然后重启 DeepSeek Harness。

## 码道 CodeArts 怎么用（第 4 家）

码道的「每日签到」只在网页端（`https://devcloud.cn-north-4.huaweicloud.com/chat/home`）的
**左下角头像 →「活动福利」→「每日领取」** 里，没有本地客户端登录态可读，所以走无头浏览器方案：

1. **登录一次**：双击插件目录里的 `码道登录.cmd`，在打开的浏览器里用华为云账号登录；
   检测到登录成功后窗口自动关闭，登录快照写到 `%USERPROFILE%\.dsh\codearts-session.json`。
2. **之后每天自动领**：DSH 启动时插件会调用 `codearts-claim.mjs`：
   - 启动无头 Chromium（持久化 profile：`$DSH_HOME\codearts-profile`）；
   - 把登录快照里的 Cookie 注入浏览器，华为云 SSO 会用票据自动续上登录态；
   - 在页面内调领取接口（`活动福利` 的 `ops/delivery` + `ops/claim` + `ops/confirm`），今天未领则领取；
   - 把刷新后的登录快照写回，供下次使用。
3. **登录过期时**：面板会出现「码道登录态已过期：请运行「码道登录.cmd」重新登录」——重新点击登录一次即可。
   登录快照有效期取决于华为云 SSO 会话；快照丢失/损坏时插件会直接提示登录，不会空等浏览器。

图标说明：个人体验版 100 积分/天、个人标准版 150、个人高级/旗舰版 200（官方规则：
<https://support.huaweicloud.com/offers-codeartsagent/codeartsagent_offers_0004.html>），当日领取当日有效，
活动截止 2026-12-31。

## 工作方式（技术）

- Host 半（`index.mjs`）：读取客户端登录态 → 调各平台官方接口 → 写状态文件；向本地 Web UI 暴露
  `GET/POST /daily-checkin/status`（GET 查询/跨天补签，POST 重试）。
  - WorkBuddy：借用 WorkBuddy Electron 解 `$wbEncrypted` 信封（AES-256-GCM）。
  - WPS 灵犀：DPAPI 解 Chromium 主密钥 → 读 WPS Office CEF Cookie（`node:sqlite`）；
    宿主不支持 `node:sqlite` 时自动用 DSH 自带 Node 子进程兜底（`cookies-helper.mjs`）。
  - Qoder：DPAPI + AES-GCM 解 `auth.v1.dat`，读取活动接口并领取。
  - MiniMax Code：读 `auth.json` 里的 OAuth accessToken，按客户端同样的签名（`yy` / `x-signature`）调
    `minimax-cloud/api/v1/signin/status`，今天可领时再 `POST signin/claim`（7 天一轮的连签积分）；
    再用 `credit/details` 汇总积分余额/过期日（只展示，拿不到也不影响签到）。
    插件不刷新 token（refresh token 是轮换式的，插件刷新会把 MiniMax Code 自己踢下线），
    token 过期时提示打开一次 MiniMax Code 让它自己刷新。
  - 码道 CodeArts：spawn 无头浏览器脚本 `codearts-claim.mjs`，由它注入登录快照、页面内调接口领取。
- Client 半（`client.js`）：标题栏按钮注册在 `conversation.session.header.actions`；
  结果面板注册在 `shell.overlay`（宿主全局浮层），DSH 0.2.x 下不会被会话头部裁剪。

### 码道相关的文件

| 文件 | 用途 |
|---|---|
| `码道登录.cmd` | 双击运行，打开浏览器人工登录一次 |
| `codearts-login.mjs` | 登录助手（`--headless` 可用于自检登录快照是否有效） |
| `codearts-claim.mjs` | 日常领取：注入登录快照 → SSO 续期 → 调接口领取 |
| `codearts-browser-common.mjs` | Playwright 启动、登录检测、快照读写等公共函数 |

Playwright 解析顺序：`$PLAYWRIGHT_CORE_PATH` → `%APPDATA%\npm\node_modules\@playwright\cli\node_modules\playwright-core`
→ 全局 `playwright-core` / `playwright`（含 nvm-windows 布局）→ 插件本地 `node_modules`。
缺 Playwright 时面板会提示安装：`npm i -g @playwright/cli`（或 `npm i -g playwright`），
再执行 `npx playwright install chromium` 装浏览器内核。

### 环境变量（可选）

| 变量 | 作用 | 默认 |
|---|---|---|
| `CODEARTS_DISABLED=1` | 完全跳过码道这一项（不用华为云时省去启动等待） | 不跳过 |
| `MINIMAX_DISABLED=1` | 完全跳过 MiniMax Code 这一项 | 不跳过 |
| `MINIMAX_AUTH_FILE` | MiniMax Code 登录态文件路径 | `%USERPROFILE%\.mavis\auth\prod\cn\mcode-public\auth.json` |
| `CODEARTS_BASE_URL` | 码道站点地址 | `https://devcloud.cn-north-4.huaweicloud.com` |
| `CODEARTS_PROFILE_DIR` | 浏览器持久化 profile 目录 | `$DSH_HOME/codearts-profile` |
| `CODEARTS_STATE_PATH` | 登录快照路径（含 Cookie，注意保密） | `$DSH_HOME/codearts-session.json` |
| `CODEARTS_LOGIN_TIMEOUT_MS` | 登录检测等待上限 | 人工登录 10 分钟 / 自动领取 45 秒 |
| `CODEARTS_CLAIM_TIMEOUT_MS` | 插件等待领取子进程的上限 | 180 秒 |
| `PLAYWRIGHT_CORE_PATH` | 手动指定 playwright-core 文件或包目录 | 自动探测 |
| `PLAYWRIGHT_BROWSERS_PATH` | 手动指定 Playwright 浏览器内核目录 | 自动探测 |

> `$DSH_HOME` 未设置时默认 `%USERPROFILE%\.dsh`。登录快照写入用「临时文件 + rename」原子替换并尽量设 0600；
> Windows 上实际保护依赖用户目录 ACL，请勿把快照文件拷给别人。

## 面板挂载方式（DSH 0.2.x 注意）

面板不放在会话头部内部：DSH 0.2.x 的会话区祖先节点带 `overflow`/`transform`，
挂在头部里的 `position: fixed` 面板会被裁掉（点开看不见）。因此面板挂到 `shell.overlay`，
标题栏只保留按钮，靠模块级 store 同步开关。

## 更新日志

- **1.4.0**：MiniMax 行增加积分余额 / 过期日 / 明日奖励 / 本周期进度（`credit/details` 汇总）；
  面板支持第二行小字。新增跨天自动补签：DSH 一直开着时每小时检查日期，跨天自动再跑一轮，不用重启。
- **1.3.0**：新增「MiniMax Code」每日签到领积分（只读桌面版 OAuth 登录态，不刷新 token）。
- **1.2.0**：新增「码道 CodeArts」每日签到（无头浏览器 + 登录快照注入 + SSO 自动续期）；
  Chromium Cookie 解密支持 host 绑定（sha256 host 前缀）。登录入口：面板提示 + `码道登录.cmd`。
  面板请求改为有上限等待，避免码道首次领取拖慢打开面板；签到运行做了并发去重。
- **1.1.0**：面板改挂 `shell.overlay`，修复 DSH 0.2.x 下点开看不见的问题；打开面板时自动刷新一次数据。
- 1.0.0：首个版本。

## 卸载

在 DSH「设置 → 插件」中停用/卸载本插件，或让插件管理器移除 `dsh-daily-checkin`。
状态文件可手动删除：`%USERPROFILE%\.dsh\.daily-checkin.json`。
码道登录态可删除：`%USERPROFILE%\.dsh\codearts-profile\` 和 `%USERPROFILE%\.dsh\codearts-session.json`。

## 说明

- 接口来自各客户端/网页端（非官方开放 API），客户端或网页升级后可能需要更新本插件。
- 仅用于使用者自己的账号；`claim` 幂等，不会重复领取。
- 码道登录快照含你的登录 Cookie，请勿外传；插件只在本地内存/本机文件里使用。
- 与腾讯、WPS/金山、阿里巴巴、华为、MiniMax、DeepSeek 均无隶属关系。

## 许可

MIT

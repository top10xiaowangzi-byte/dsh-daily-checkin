# dsh-daily-checkin（DeepSeek Harness 插件）

一个只装进 DeepSeek Harness 的签到插件：**DSH 启动时自动完成 WorkBuddy、WPS 灵犀、Qoder 三家的每日签到**，
并在会话标题栏显示签到入口与结果面板（失败项可重试）。

## 作用

- **启动自动签到**：DSH 启动时依次处理 WorkBuddy（国内版）、WPS 灵犀、Qoder；各平台独立，一个失败不影响其它。
- **幂等**：今天已签到的只报告「已签到」，不会重复领取；跨天后第一次打开面板会自动补签当天。
- **标题栏面板**：会话标题栏出现签到图标 + 条目数 + 状态点（绿=全部成功、黄=部分失败、红=全部失败）。
  点开可看每个平台的连签/积分/奖励，失败项可一键重试。
- **登录态只读**：只读取本机客户端登录态，token/cookie 只在内存中解密，不落盘、不打印。
- **状态落盘**：`$DSH_HOME/.daily-checkin.json`（最近一次结果，供面板显示）。

## 前置条件

1. 本机安装并登录过对应客户端（登录过哪个就签哪个）：
   - WorkBuddy 国内版（登录态在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`）
   - WPS 灵犀 或 WPS Office（优先共用 WPS Office 登录态）
   - Qoder CN 桌面版（`%APPDATA%\com.qodercn.app.stable\`）
2. Windows（WPS/Qoder 的登录态解密依赖 Windows DPAPI；WorkBuddy 解密依赖其 Electron 客户端）。
3. DSH 0.2.x 桌面/Web 运行环境（插件不 import 任何 `@deepseek-ai/*` 包，不挑内核小版本）。

## 安装

```text
dsh plugin --profile <profile> add file:<本目录绝对路径>
```

或用 DSH 插件管理器「安装本地插件」选择本目录，然后重启 DeepSeek Harness。

## 工作方式（技术）

- Host 半（`index.mjs`）：读取客户端登录态 → 调各平台官方接口 → 写状态文件；向本地 Web UI 暴露
  `GET/POST /daily-checkin/status`（GET 查询/跨天补签，POST 重试）。
  - WorkBuddy：借用 WorkBuddy Electron 解 `$wbEncrypted` 信封（AES-256-GCM）。
  - WPS 灵犀：DPAPI 解 Chromium 主密钥 → 读 WPS Office CEF Cookie（`node:sqlite`）；
    宿主不支持 `node:sqlite` 时自动用 DSH 自带 Node 子进程兜底（`cookies-helper.mjs`）。
  - Qoder：DPAPI + AES-GCM 解 `auth.v1.dat`，读取活动接口并领取。
- Client 半（`client.js`）：标题栏按钮注册在 `conversation.session.header.actions`；
  结果面板注册在 `shell.overlay`（宿主全局浮层），DSH 0.2.x 下不会被会话头部裁剪。

## 面板挂载方式（DSH 0.2.x 注意）

面板不放在会话头部内部：DSH 0.2.x 的会话区祖先节点带 `overflow`/`transform`，
挂在头部里的 `position: fixed` 面板会被裁掉（点开看不见）。因此面板挂到 `shell.overlay`，
标题栏只保留按钮，靠模块级 store 同步开关。

## 更新日志

- **1.1.0**：面板改挂 `shell.overlay`，修复 DSH 0.2.x 下点开看不见的问题；
  打开面板时自动刷新一次数据。
- 1.0.0：首个版本。

## 卸载

在 DSH「设置 → 插件」中停用/卸载本插件，或让插件管理器移除 `dsh-daily-checkin`。
状态文件可手动删除：`%USERPROFILE%\.dsh\.daily-checkin.json`。

## 说明

- 接口来自各客户端（非官方开放 API），客户端升级后可能需要更新本插件。
- 仅用于使用者自己的账号；`claim` 幂等，不会重复领取。
- 与腾讯、WPS/金山、阿里巴巴、DeepSeek 均无隶属关系。

## 许可

MIT

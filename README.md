# Tokei for Windows · Windows 托盘 AI 编程用量监控

常驻系统托盘，读本机各 AI 编程 CLI / IDE **自己写在本地的日志与数据库**，算出 token、成本（美元 + 人民币）和套餐额度：任务栏一眼可见，点开面板看细节。用量数字全部来自本地文件，不涉及任何上传；只有套餐额度的实时查询会在用户明确勾选后，用该工具已有的本机登录态或用户自己填入的 Key 向对应服务商发一次请求。

本项目是 macOS 版 [Tokei 知度](https://github.com/cclank/tokei) 的 Windows 移植：

- **数字口径**对齐原版采集引擎 `usage.30s.py`（同一份定价表、同一套去重与区间规则）；
- **界面与交互语义**对齐原版 Swift 源码（`PanelView.swift` / `MenuBarStyle.swift` / `DashboardView.swift` …）；
- **数据文件与键名两边共用**：设置、账本、额度曲线、缓存全部落在 `%USERPROFILE%\.tokei`，键名与 macOS/Python 完全一致，从 Mac 迁过来的历史直接可读。

技术栈：Electron 44 + TypeScript（strict）+ 原生渲染层，**运行时零 npm 依赖**（`dependencies: []`）。SQLite 走 Node 内置 `node:sqlite`，托盘出图走隐藏渲染窗 + canvas，都不引第三方原生库。

## 支持的工具：32 个工具键

**本地日志 / 数据库采集（27 个）**

Claude、Codex、Gemini、Grok、Grok Bot、Qoder Desktop、QoderWork、Qoder CLI、Qoder CN、Hermes、ZCode、MiMoCode、OpenClaw、Pi、Prime Agent、WorkBuddy、WorkBuddy Intl.、CodeBuddy、DeepSeek Harness、OpenCode、Qwen Code、千问办公、Kimi Code、Muse Code、Command Code、Devin、MiniMax Code

**以额度/账号为主的来源（5 个）**

Antigravity、Cursor、Zed、Sub2API、z.ai / GLM

指标随工具能力而变：输入/输出/缓存/推理 token、成本、会话数、模型分布、项目归属、套餐与加购余额、周期限额。套餐额度里 Claude 走 Claude Desktop 的本地缓存，Codex/Kimi/Grok 走各自 CLI 已有的登录态，其余需要用户在设置页明确填入 Key。

## 你能看到什么

**托盘图标**：7 种样式（经典白 / 彩色 / 刻度 / 圆点 / 数字 / 星轨 / 椰影）× 3 档信息量（双额度 / 单额度 / 仅图标）。墨色自动跟随任务栏深浅 —— 读 `HKCU\...\Themes\Personalize`，Win11 看 `AppsUseLightTheme`、Win10 看 `SystemUsesLightTheme`，60 秒轮询跟上；出图失败退回 `resources/` 里预制的兜底 PNG，绝不出现空白图标。

**面板**（420×640 无边框窗）：Win11 22H2 起（build ≥ 22621）走亚克力透明底并跟随任务栏深浅色，更旧的 Windows 退回实色底。

| 页 | 内容 |
|---|---|
| 用量 | 按工具卡片 + 闲置工具折叠，区间 7 档：今日 / 昨日 / 本周 / 上周 / 本月 / 今年 / 全部 |
| 额度 | 实时额度卡、168 小时额度曲线、1 月 / 1 年明细与周额度周期卡 |
| Dashboard | 全年热力图、模型 / 项目排行、单日下钻、Wrapped 年报 |
| 项目轨迹 | 按项目聚合的历史用量与检索 |
| 设置 | 工具显隐卡片、菜单栏（样式 / 信息量 / 额度来源）、Provider 凭据与额度、远程采集、隐私与额度、久坐提醒、系统、运行诊断 |

**刷新节奏**：面板可见 10 秒、后台 30 秒，并按上一轮耗时 ×2 退避防止扫描堆积；2 秒 tick 对齐原版 `main.swift`。

## 系统能力（Windows 化实现）

| 能力 | 做法 |
|---|---|
| 开机自启 | `app.setLoginItemSettings({ openAtLogin })` |
| 防休眠 | `powerSaveBlocker`：保持亮屏 = 防关屏 + 防系统睡眠；允许关屏 = 仅防空闲睡眠；带低电量保护 |
| 久坐提醒 | `powerMonitor.getSystemIdleTime` 作 macOS `IOHIDSystem` 的等价物，30 秒 tick，空闲满 5 分钟视为离开并清零 |
| 单实例 | `requestSingleInstanceLock`，二次启动直接把面板叫出来 |
| 托盘交互 | 左键 / 双击开面板；右键菜单：打开面板、立即刷新、菜单栏样式、菜单栏信息量、状态栏额度（三项均为子菜单）、开机自启、防休眠、退出 |

## 凭据与隐私

- 密钥用 Electron `safeStorage`（Windows **DPAPI**，绑定当前 Windows 账户）加密后存 `~/.tokei`，等价 macOS 的 Keychain；换账户解不开会明确报原因而不是静默失败。
- **渲染进程只能问「存没存」，拿不到明文**：面板用 `innerHTML` 铺数据，把密钥交给渲染进程等于给一次注入就等于泄露。
- 联网取额度**默认全关**，必须在设置页隐私段明确勾选；凭据缺失时直接返回空结果，绝不发请求。HTTP 层**不跟随重定向**，防止凭据被送到另一个域。同一凭据 5 分钟内的读数复用缓存，请求失败退回 1 小时内的旧读数并标记陈旧。
- Token 统计只读本地文件；`CodeBuddy` 一类明确不读账户余额。

## 数据持久化

`%USERPROFILE%\.tokei\` 下（与原版同名同构）：

- `config.json` — 设置，键名与 Python/macOS 共用，两边可互相迁移
- `last_usage.json` — 最近一轮采集结果
- `ledger.json` — 持久账本：CLI（如 Claude Code 默认 30 天清理）删掉旧日志后，历史用量不再缩水
- `quota_history.json`、`quota_detail.json`、`quota_cycles.json` — 额度曲线与明细
- `*_quota_cache.json`、`*_scan_cache.json` — 各来源缓存（含凭据指纹 marker，换账号即失效）

坏文件不崩应用：所有读取走统一的容错加载，脏值回落到默认设置。

## 构建与运行

需要 Windows 10/11 与 Node.js 22.5+（用到内置模块 `node:sqlite`，不装原生依赖）。

```bash
npm install        # 只有 4 个 devDependency
npm run build      # tsc → dist/
npm start          # 起托盘应用
npm run cli -- --json      # 无 UI 跑一遍采集引擎
npm test           # 构建 + vitest
```

CLI 其他出口：`--projects`（按项目足迹，紧凑 JSON）、`--errors`（把各采集器的错误打到 stderr）、`--compact`（输出压成单行）。默认输出与原版 `main_json()` 同形，并额外挂一份 `_pricing` 价表水位，设置页的诊断段就报这一行。

## 目录结构

```
src/core/        采集与计算引擎：路径发现、定价、区间、账本、额度归一化（纯函数，可单测）
src/collectors/  本地日志 / SQLite 扫描器（覆盖 27 个工具键）+ Claude 套餐缓存扫描
src/main/        Electron 主进程：托盘出图、面板、设置、DPAPI、13 路联网额度、诊断、防休眠
src/cli.ts       无 UI 出口，与 --json 同形
renderer/        面板：index.html + app.js + styles.css
resources/       定价表 507 条、价格覆盖、托盘兜底 PNG
test/            vitest 用例
scratch/         验证夹具与无头渲染度量脚本
```

## 怎么验证的

- `npm test`：37 个文件 / 587 个用例，覆盖定价、去重、区间切分、账本合并、每个额度 fetcher 的信封拆解与降级路径。fetcher 单测一律用临时目录夹具（`node:sqlite` + `TOKEI_*` 环境变量注入），**不碰真实 `~/.tokei`**。
- 界面几何不靠肉眼：`scratch/panel-harness.cjs` 生成真实样式的静态页，`scratch/edge-one.sh` 用 headless Edge 多档视口量盒子相交与文字溢出，逐元素核对与 Swift 源一致的间距、截断、换行。

## 已知未完成

- Git 多设备同步与设备范围切换（`sync_dir` / `device_id` 键已就位，链路未接）
- 自动更新器、自动抓价、应用活跃统计
- 用量页的额度型紧凑卡（Cursor / Zed / Sub2API / z.ai / Antigravity）
- CLI 的 `--quota-detail` 出口尚未接上（额度明细只在面板里出）
- CLI 出口暂不带实时额度（DPAPI 凭据只能在有桌面会话的进程里解）
- 暂无英文界面表

## 许可

MIT，见 [LICENSE](LICENSE)。

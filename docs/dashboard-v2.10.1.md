# v2.10.1：自动资源扫描与页面滚动

基线 `b146cf84e5d25dde327c61161d854f2d239b5a28` / v2.10.0；日期 2026-10-14。所有本地性能、CF 返回值、浏览器数据及容器账号均为**合成数据**，没有使用真实 Cloudflare 凭据。未提交、推送或生产部署。

## 根因与结果

v2.10.0 的四个 Dashboard GET 只查本地 overview、汇总和模块缓存；真正采集由页面中的串行循环驱动。新部署没有快照时不会自动扫描，关闭页面也会失去该执行入口。滚动方面，主布局固定高度并关闭外层 overflow，而 `overview-page` / `audit-page` 没有自身滚动，内容被裁切。

v2.10.1 保留原统计模型和七类目录读取。首次进入 Dashboard 发出幂等扫描 POST，快速本地 GET 同时展示；后端保存每项进度，页面每 4 秒读轻量状态，仅完成数变化或结束时刷新汇总。离页、切换账号、退出及认证失效只清理前端查询，不取消全局任务。没有完成时间估算。

## 触发与配置

| 触发 | 行为 |
| --- | --- |
| 首次认证进入 / Docker 启动 | 补齐缺失快照；多个标签复用活动任务 |
| 周期校准 | 默认 24 小时，调度时间由持久化 control 保存 |
| Account 新建、启用、绑定、产品开关或代理变更 | SQL trigger 持久化 dirty，执行时重新核对可用绑定 |
| Credential 认证字段变化 | 定向标记所有关联绑定，不沿用旧身份 |
| Zone / Workers / Pages / Tunnel / KV / D1 / R2 创建删除 | 审计目录回执 trigger 或明确调用 markScanDirty，只失效受影响产品；跨账号 Zone 删除逐账号标记，商店部署包含实际部署产品及自动创建绑定 |
| 手动采集 | 缺失/过期、当前范围强制、全部账号强制；活动任务复用，已完成项不会在同一任务中重复读取 |

`DASHBOARD_AUTO_COLLECT=true`、`DASHBOARD_SCAN_INTERVAL_HOURS=24`、`DASHBOARD_SCAN_CONCURRENCY=2`（1–4）、`DASHBOARD_SCAN_STARTUP_DELAY=15`（秒）。可选 `DASHBOARD_SCAN_WINDOW_UTC=18-21` 为北京时间 02:00–05:00 的后续校准窗口；首次补齐仍立即响应认证进入。配置已接入 `.env.example`、Compose 和 Worker Env。

关闭自动采集不创建新的自动任务；已有持久化任务保留，可手工暂停/恢复。暂停停止新领取，已经在读的资源可以完成。Tunnel 沿用项目现有活跃绑定范围，没有新增独立产品开关；其他资源遵守原 `enabled_features`。

## 持久化与恢复

SQLite/D1 0014 使用四张表：

| 表 | 内容 |
| --- | --- |
| dashboard_scan_jobs | jobId、触发、完整扫描标记、状态及开始/结束时间 |
| dashboard_scan_items | 真实 CF Account / 产品唯一项、本地绑定 ID、身份摘要、状态、尝试、冷却、租约与 revision |
| dashboard_scan_control | 下次周期时间、全数据库执行租约 |
| dashboard_scan_dirty | 绑定/产品变更及 revision |

总数、完成、成功、失败、跳过和当前资源从真实任务行计算，进度不会超过实际已完成项。只有全部待执行项终结才结束任务；失败项产生 `completed_with_errors`，全部失败为 `failed`，不会将读取失败计为零。

活动任务由 `active_key UNIQUE` 持久化去重；规划用 SQLite transaction / D1 batch，执行用 90 秒租约，跨进程/isolate 不重复领取。正常停止取消读取、保存待续项并释放租约；异常退出在租约过期后恢复，重新读取最新绑定、凭据与产品状态。资源变更回执立即增加活动项 revision 并提升摘要失效水位，防止旧列表在下一规划 tick 前覆盖 fresh。身份与资源 revision 都在提交时核对，SQL 条件写入再次保护“校验后、保存前”发生的凭证变化。队列不保存 Token、Global Key、认证头、明文环境变量或 CF 完整响应；加密认证字段只作为瞬时 SQL 绑定条件，不写入任务表。

同一真实 CF Account/产品只计一份，权限失败可选择其他有效绑定，最多三次尝试。403、429、网络、超时分别记录；429 保存 Retry-After 并至少冷却 5 分钟，变更凭据/手动操作也不绕过该冷却。其他失败不会形成即时无限重试。完成任务保留 30 天，保留活动任务、最新完整扫描和未过期冷却。

最近成功的完整模块缓存会在规划中保存为持久化数量后跳过；完整 KV 列表回执和完整 R2 缓存游标链也可复用，部分分页不能提供完整数量。成功快照继续使用原 5 分钟展示有效期；读取失败保留旧成功时间和值并标记 stale/error，快照不是实时健康状态。

## Docker 执行器

`dashboardScanRuntime` 在 DB 初始化、Express listen 完成后按配置延迟启动。管理的计时器保存当前批次 Promise，默认全局两项、每真实 Account 一项；读操作进入原低优先级 ReadScheduler，执行器自身不占另一个 scheduler 槽位。前台读取保留优先级与可用槽位。

每项完成立即持久化。空闲定时检查只查 control/dirty，不反复计算全账号或写空闲租约。SIGTERM / SIGINT 停止领取、取消在读请求并尽量保存；硬退出依靠租约恢复。无需 Redis、队列服务或新必需外部组件。

## Pages / Worker 方案与限制

当前产物为 Pages Advanced Mode `_worker.js`。**Pages 不支持 Cron Triggers**，导出 `scheduled()` 不代表启用定时执行；原 index 的 scheduled 注释已明确。见 [Cloudflare 功能对照](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) 与 [Advanced Mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)。

认证的 start/resume，以及运行中 status 请求通过 waitUntil 推进一个资源：最多 35 次 CF 请求，20 秒读取预算；进度保存在 D1，没有驻留循环或递归自调用。下一次合法触发继续，isolate 消失后租约到期恢复。waitUntil 官方最多延长响应后 30 秒，D1 操作及平台 CPU 限额仍由实际运行时控制；不承诺 Free CPU 在任意大规模账号下的生产表现。见 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)。

D1 Free 每 invocation 最多 50 查询，每 SQL 100 参数；规划采用 json_each 集合写入，120 账号的规划加首批执行在合成查询预算测试内。见 [D1 限额](https://developers.cloudflare.com/d1/platform/limits/)。单资源超出 35 次上游/时间预算会失败并保持未知或旧快照，不保存部分目录为完整成功；当前版本没有上游分页游标跨 invocation 续传。

浏览器关闭后，Pages 的当前批次可以在 waitUntil 预算内完成，后续无请求时会停在 D1；完全无人访问时的持续定时执行需要可选独立 Scheduled Worker：

1. 使用 `worker/wrangler.dashboard-scheduler.toml`，绑定与 Pages **相同**的 D1。
2. 通过 Wrangler secret 配置相同 ENCRYPTION_KEY，不将密钥写入配置文件。
3. 保持 AUTO_COLLECT / 周期 / 窗口与 Pages 一致。Cron 每分钟推进一项；120×7 项在无错误、无请求协助时约需 840 次触发，不是浏览器速度。
4. `npm run build:scheduler` 验证独立打包；实际发布由用户操作，不能把本地测试称为已部署。

没有为 Docker 增加 Cloudflare 服务购买要求。

## API

原 overview/resources/trends/activity 和 collect 保留。四个查询仍不访问 CF；旧 collect 和队列共用执行租约，冲突返回 409。

- `GET /api/dashboard/scan/status`：真实状态、分产品计数、最近完整扫描结果、下次计划。
- `POST /api/dashboard/scan/start`：reason=auto/manual，可选 accountId、metrics、force。
- `POST /api/dashboard/scan/pause` / `resume`：管理平台认证内的持久化操作。

健康检查没有任务创建或状态修改。接口不返回凭据或内部身份摘要。

## 滚动

两页桌面 `flex:1 1 0%`、受限高度、`min-height:0`、`overflow-y:auto`；Grid `align-content:start` / `grid-auto-rows:max-content` 防止卡片拉伸。768px 及以下恢复文档流，由已有 mobile-layout 唯一滚动。App.vue / 全局 overflow 规则保持，其他模块独立滚动不变。

页面自身聚焦时 Home/End 定位两端，输入框/图表/下拉自己的键不拦截。活动长目标在手机上单独换行，审计账户列可省略并提示，Drawer 长内容保持原独立滚动。

## 升级与回滚

先备份数据卷 / D1，保持 ENCRYPTION_KEY 原样。Docker 自动幂等初始化 0014；Pages 发布新 `_worker.js` 前运行 `D1_NAME=cf-manager npm run db:migrate`（实际绑定名依部署配置）。不能只更新前端；新 API 和 schema 需整体发布。

D1 迁移切分器新增 trigger BEGIN/CASE/END 支持，禁止回退为简单 split(';')。Schema 检查同时验证双端新表存在、共享列和迁移新表/列集合。重复迁移保持凭据密文和 Account 主键。

回滚前暂停扫描并停止可选 Scheduled Worker，恢复 v2.10.0 整体产物；可保留新增表供再次升级。若保留表，旧模块操作仍会由 trigger 记录 dirty，不删除任何 CF 资源；停机恢复完整备份是需要精确数据库回滚时的方案。

## 验证与性能证据

最终测试/构建及原始结果见本目录 JSON；全部为本地合成数据，真实 CF 权限、D1 部署、生产网络、Free CPU 和原生 AMD64 环境仍需部署验收。

- `dashboard-scroll-v2.10.1-before.json` / `dashboard-scroll-v2.10.1.json`：四视口 × 明暗 × 两页，真实滚轮、滚动位置、End 到底、50 记录分页、Drawer 和移动原生触摸；没有用 fullPage 截图判定通过。
- `dashboard-auto-v2.10.1-before.json` / `dashboard-auto-v2.10.1.json`：20/60/120 账号首屏、入队、CF 模拟调用、并发、完成计数、本地 HTTP；三标签、浏览器关闭、认证失效后的真实后端状态。
- `dashboard-docker-v2.10.1.json`：隔离真实容器硬停止和正常停止的 SQLite/执行器恢复；CF I/O 全部替换，既有完成项不重读。

| 账号 | 基线首屏均值 ms | 新首屏均值 ms | 自动完成 ms | 模拟 CF 调用 |
| --- | ---: | ---: | --- | ---: |
| 20 | 201.13 | 178.08 | 4352–4390 | 140 |
| 60 | 165.54 | 162.03 | 7427–7470 | 420 |
| 120 | 168.87 | 199.81 | 12755–13215 | 840 |

每个规模仅明/暗两个首屏样本，不能视为稳定 P95；基线自动完成为空（没有自动任务）。20/60 账号此次首屏略有改善，120 账号增加约31ms，主要多了入队/状态初始化；没有宣称所有规模变快。新页面已在模拟上游首批延迟3秒时展示本地统计。后端模拟扫描默认并发2，各产品成功数分别为20/60/120、失败0、429为0；部分失败、429和冷却在独立合约测试覆盖。

每组40个 Node HTTP/SQLite夹具样本：后台扫描期间 overview P50 0.45–0.95ms、P95 0.99–3.14ms；基线 P50 0.44–0.79ms、P95 0.81–1.60ms。120账号存在少量尾延迟增加，仍未等待模拟CF读取。该结果不是部署后的Express/TLS/D1性能保证。入队耗时约6–43ms。

真实隔离容器硬停止后恢复成功28/28：90秒租约到期后继续，含剩余采集总恢复约116.6秒；已完成资源没有重复读取。正常停止后恢复约28.7秒。原始报告记录30次模拟调用（28个资源加2个未完成读的重试），真实CF调用0。

三端最终单测：backend 458、worker 403、frontend 120，合计981（基线879，新增102）；三端类型检查、lint 0 errors、后端构建、/admin 前端与Worker ZIP、独立调度打包、双端Schema通过。保持存量 lint 警告、大chunk提示和 node-cron 缺少 sourcemap 源文件提示。ARM64镜像构建和原隔离启动矩阵通过。

浏览器：新增16组严格滚动、6组自动采集+2项多标签/离页/认证验收、原32组Dashboard/Audit回归，以及原Workers/Pages、Zone/Storage/D1、Tunnels/Rules、Catalog和独立长列表滚动矩阵均通过。

Wrangler 4.151.0 的本地workerd/D1通过28条schema、trigger/json_each/租约/同值更新SQL；独立Scheduled Worker dry-run通过，无远端D1访问或部署。

复验命令：三端 `npm test` / `npm run typecheck` / `npm run lint`，`node scripts/check-db-schema.mjs`，backend/frontend/worker 的 `npm run build`，worker `npm run build:scheduler`，`node scripts/test-dashboard-docker.mjs <测试镜像>`、`node scripts/test-docker.mjs <测试镜像>`。浏览器脚本 `test-dashboard-scroll-ui.mjs`、`test-dashboard-auto-ui.mjs`、`test-dashboard-ui.mjs` 使用 PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE / FRONTEND_DIST；全量构建后冻结前端，再测试。


构建发现两个存量依赖告警，已升级 compression 1.8.2 和 proxy-addr 2.0.8 兼容补丁；没有新增必需服务。对应 [compression 公告](https://github.com/advisories/GHSA-vc2v-76pw-4v95)、[proxy-addr 公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)，npm audit --omit=dev 已为0。

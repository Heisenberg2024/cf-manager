# v2.10.2：持久化快照一致性与 Cloudflare 总览

基线 `dd0e3a3f0b145bde5042562d416a00422eabbaef`（v2.10.1），日期 2026-10-14。所有浏览器、Cloudflare 响应、D1 与容器数据均为**本地合成夹具**；没有使用生产凭据或执行真实 Cloudflare 写入。未提交、推送或部署。

## 根因与修复

开发前新增五个失败用例，旧版五项全部失败：6 分钟后状态变为 stale、改名/最近检测更新使持久化数量消失、冷实例看不到普通模块读取结果、进程内结果覆盖数据库汇总，以及目录变更被当作读取失败。原有失败、权限、429、身份隔离、分页与任务恢复测试保留。

| 根因 | 当前行为 |
| --- | --- |
| aggregateResources 的 300000ms 同时承担快照状态与错误判定 | API TTL 保持原策略；独立 snapshotPolicy 使用配置扫描周期。年龄只影响 due / longUnupdated，成功值不会因时间变 error/stale |
| bindingSignature 含 account.updated_at，提交 guard 也比较更新时间 | 模块缓存签名保留；新增独立 inventory:v2 身份与 snapshot_epoch。显示名称、检测时间、普通元数据不影响统计 |
| Dashboard GET 合并未持久化的模块 peek | currentSnapshots 只读取 SQLite/D1 resource_summaries，两个实例无需共享进程缓存 |
| 完整模块结果只在规划阶段偶尔保存 | 现有目录读取器完成真实完整读取时，inventorySink 立即持久化。部分分页、缓存命中不伪造新确认时间 |
| invalidated 混入读取错误 | invalidated_at 表示等待同步，last_failed_at / error_kind 表示真实失败。异常事项不包含快照年龄 |
| 每日任务开始时，昨天稍晚完成的资源尚未满 24h | 到期的周期校准实际读取资源，避免全部跳过造成实际隔天扫描；首次补齐和手动缺失采集仍复用有效成功值 |

真实 CF Account + 资源类型/ID 的既有去重保留。多个凭证不相加；选取最新成功数量，同时间按错误、尝试时间和本地 ID 固定排序。较旧的健康凭证不能替代较新的已确认历史数量。失败保留上次成功值、breakdown 与时间；未知用 null，停用、未绑定/无认证数据和不可采集覆盖单独记录。关闭某产品不等于远端资源为零。

## 时间、身份与迁移

- API Cache TTL：沿用已有读取器的 30s 列表、120s 用量等策略。
- Inventory Refresh Interval：默认 24h，沿用 DASHBOARD_SCAN_INTERVAL_HOURS 和原 UTC 执行窗口。
- Snapshot Age：来自服务器 last_success_at；达到刷新周期仅为 due，默认 48h（两个配置周期）标记 longUnupdated，只在详情提示。
- Snapshot Invalidation：目录回执只更新对应真实 Account/metric 的 invalidated_at 和失效水位，保留历史数量；任务 revision 防迟到提交。
- Last Successful Collection：资源自己的实际成功确认时间。缓存命中、有效跳过和任务结束不能替代它。
- Last Failed Collection：新失败保存服务器完成时间，旧成功值不被 null/0 覆盖。查询时间 fetchedAt 只表示汇总响应生成时间。

自定义窗口可能推迟计划执行，抽屉展示真实 nextScanAt；年龄提示不代表 CF 故障或凭证失效。快照不保证远端资源的实时健康、账单或交易一致性。

SQLite 自动迁移 / D1 **0015_dashboard_snapshot.sql** 增加四列：accounts.snapshot_epoch、resource_summaries.last_failed_at、invalidated_at 和 dashboard_scan_control.snapshot_revision。新增触发器记录单调摘要版本，真实认证/绑定/代理变更推进 epoch 并删除对应绑定的失效汇总；认证 A→B→A 也拒绝旧结果。主键、资源、密文及 ENCRYPTION_KEY 均未更改。没有新增依赖或 Redis。

旧 v1 快照只有真实 CF 身份、原认证签名精确匹配且 epoch=0 时才能继承；幂等规划会将安全继承的身份持久化，即使没有新任务。无法确认的旧数据单独提供 historicalValue，页面标为历史待确认，排除在已确认资源分布外。发生过安全变更后，旧运行时写入的 legacy 身份也不能再次被认证为当前结果。

成功目录更新受当前绑定 SQL guard、开始时间水位与任务租约/revision 保护。旧缓存不能覆盖新数据或清除新失效；提交未落库时不能返回虚假成功。R2 完整首页面和完整游标链可提供 Bucket 数量，Objects、过滤页及末页不提供全目录数量。普通 SWR 返回历史列表，后台只有真实完整成功才写汇总，不把“刷新中”伪装为读取失败。

## 首页和后台采集

首页顺序为标题/账号筛选/刷新/更多、六张统计卡、单单位用量趋势与实体分布、需要关注与最近操作、分页账号概览。桌面三列，1024px 两列，768px 图表单列，390px 统计单列。保持现有导航、明暗主题和滚动体系。

Workers / Pages 各自保留未知和失败；部分统计用 ≥ 表示下限。KV / D1 / R2 独立展示，R2 为 Bucket 数量。分布只用确认数量，未知不算 0，历史待确认不参与比例。趋势直接使用 quota_usage 的真实已记录数据，7/30 天及指标切换，各单位独立；日期缺失留空，不插值补零。没有官方套餐分母或实时计费承诺。

真实失败优先于历史审计错误；Zone Pending 和 Tunnel 异常按真实 Account 去重并显示所属账号。Tunnel 的 healthy / degraded / down / inactive 分开，inactive 不计为已知故障，未知状态独立显示，依据 [Cloudflare Tunnel API 状态定义](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/list/)。

更多 → 资源快照采集打开 DashboardSnapshotDrawer，保留状态、最近成功完整任务记录、最近完整任务、进度、成功/失败/跳过、错误、计划、手动缺失、当前账号/全部强制、暂停与恢复。任务完成时间仅为任务记录，不证明每项资源刚被重新读取。正常首页不显示进度栏、逐项日志或自动成功通知，历史数字保持可见。

普通刷新只发本地汇总/趋势查询。活动任务每 4 秒、空闲每 30 秒读轻量状态，仅摘要版本或完成数变化时重读资源。离页、登出、失效登录仅清前端查询，不取消任务。Docker 执行器独立于浏览器；Pages 状态请求可在后台推进到期/dirty 的一个有界批次，无请求时仍需独立 Scheduled Worker，不能承诺 Pages 自带 Cron 或持续驻留。

## 验证与证据

首轮单测 1034 项（backend 483 / worker 428 / frontend 123，基线记录 981）；三端类型、lint 0 errors、完整构建与 ZIP/独立调度器、schema、本地 D1 和 ARM64 容器均通过。详细结果见 dashboard-validation-v2.10.2.json；性能汇总见 dashboard-performance-v2.10.2.json。原始证据：

- dashboard-consistency-v2.10.2-before.json / dashboard-consistency-v2.10.2.json：真实 Express 路由、better-sqlite3 临时文件、32 个视口/主题/规模组合，两独立浏览器上下文共享服务器；20/60/120 混合停用、权限失败、旧快照与重复真实 Account，包含当前账号强制采集、30 天筛选、卡片导航和审计入口。
- worker/src/__tests__/dashboardIsolates.test.ts：两个独立模块图/Hono HTTP 实例共享 D1 SQL 适配器，A 模块采集，B 无内存快照仍读到相同数量与成功时间。真实 workerd 本地 D1 的迁移/trigger 结果另见 dashboard-d1-v2.10.2.json。
- dashboard-regression-v2.10.2.json：原 32 组 Dashboard/Audit 回归；dashboard-scroll-v2.10.2.json：16 组真实滚轮、PageDown/End、原生触摸、分页和长字段抽屉。
- dashboard-resource-regressions-v2.10.2.json 及 regression-v2.10.2-*.json：原 DNS/Workers/Pages、Zone/Storage/D1、Tunnels/Rules、Catalog 和自动采集/多标签/离页/认证矩阵。
- dashboard-docker-v2.10.2.json：ARM64 随机测试容器和独立卷，硬停止租约恢复与正常停止恢复，28/28 项完成，已完成项不重复读取，真实 CF 调用 0。

原资源测试中的无 SQL 夹具显式隔离持久化回调；新的实际 SQL、HTTP 和跨实例用例负责持久化集成验证。没有通过删测试或将失败数量改为零来通过验收。

### 2026-10-15 用量与 R2 补充修复

Workers & Pages 页面通过共享 reader 从 Cloudflare 读到了当日真实请求量，但此前没有写入 Dashboard 使用的 quota_usage，导致页面有用量而趋势仍为空。现在完整成功的 usage 读取立即保存 Workers + Pages 的 UTC 请求量，使用当前绑定/认证 epoch 守卫；不覆盖较大的同日已记录值，不清耗尽标记，失败/部分响应不保存0。现有后台扫描在缺少当天用量时补读 analytics，复用已有成功目录；失败补读冷却5分钟，仍受原单批预算限制。Dashboard 进度变化后刷新本地趋势，无需先访问 Workers 页面。

R2 汇总与扫描读取账号的 available_features，排除 -r2；明确未开通10042或缺少R2读取作用域时持久化 not_applicable，并在扫描中尝试同一真实账号的其他凭证。全部不可用则跳过，既有R2 permission快照也从覆盖率与关注事项排除；认证、429、网络/超时仍展示真实异常。10个账号只有2个可读时，R2的覆盖与数量只由这2个账号决定。

新增双端回归覆盖用量写入、真实零观测、失败/部分响应、旧凭证迟到、目录复用、补读冷却、目录权限失败但用量可读、R2排除与其他凭证回退。补充修复后的三端单测共1056项（494/439/123），类型检查与lint 0 errors通过。`node scripts/test-dashboard-usage-r2.mjs` 直接使用当前TypeScript Express路由和独立临时SQLite，不读取真实.env或数据库：验证10个账号的当日375次请求、2个可读账号的4个Buckets、扫描失败0、普通重读新增CF请求0，见 dashboard-usage-r2-v2.10.2.json。传输为合成数据；首轮构建/浏览器/容器报告保持历史记录，本次补充未重跑这些验收。

7/30天趋势只展示实际保存过的日期。本次接入当日用量，没有假造或用当日数据回填过去日期，也没有新增远端历史回填API。

模拟状态正确率、HTTP P50/P95、首屏、Layout/RecalcStyle、脚本耗时与 JS heap 的前后数据由性能 JSON 自动汇总。每规模浏览器只有 8 个视口/主题样本，HTTP 40 个样本；没有隔离系统负载，不能视为稳定生产 P95。真实 CF 权限、远端 D1、生产网络、Free CPU 和原生 AMD64 仍需部署环境验收。


| 账号 | 已成功账号/产品状态正确率（旧→新） | 首屏 P50 ms（旧→新） | 首屏 P95 ms（旧→新） | HTTP P95 ms（旧→新） |
| --- | --- | --- | --- | --- |
| 20 | 64.4% → 100% | 197.5 → 180.5 | 224.4 → 213.3 | 6.95 → 5.58 |
| 60 | 65.1% → 100% | 203.9 → 185.5 | 220.1 → 211.0 | 12.62 → 7.49 |
| 120 | 65.3% → 100% | 193.2 → 186.9 | 211.3 → 211.1 | 31.71 → 17.65 |

首屏定义为本地账号数字实际出现。120 账号的首屏 P95 几乎相同；不宣称所有指标稳定改善。冷扫描三组首屏约174–182ms，首屏时完成项均为0，未等待模拟上游。每规模新浏览器额外CF调用均0；读取模块后新持久化数量与改名后保留均通过。渲染、脚本和内存原始值见性能 JSON。

## 截图

截图来自同一合成 20 账号夹具，普通首页未打开采集抽屉。手机首屏保持现有移动布局，可继续滚动。

| 场景 | v2.10.1 | v2.10.2 |
| --- | --- | --- |
| 桌面浅色 | [旧版](screenshots/dashboard-v2.10.1-desktop-light.png) | [新版](screenshots/dashboard-v2.10.2-desktop-light.png) |
| 桌面深色 | [旧版](screenshots/dashboard-v2.10.1-desktop-dark.png) | [新版](screenshots/dashboard-v2.10.2-desktop-dark.png) |
| 手机浅色 | [旧版](screenshots/dashboard-v2.10.1-mobile-light.png) | [新版](screenshots/dashboard-v2.10.2-mobile-light.png) |
| 手机深色 | [旧版](screenshots/dashboard-v2.10.1-mobile-dark.png) | [新版](screenshots/dashboard-v2.10.2-mobile-dark.png) |

## 升级与回滚

1. 备份完整 SQLite 数据卷或 D1，保持 ENCRYPTION_KEY 原样；停止旧执行器/可选 Scheduled Worker，避免新旧运行时同时写快照。
2. Docker 整体升级镜像，初始化自动幂等执行 0015。Pages 发布整套 v2.10.2 前，按实际 D1_NAME 运行 npm run db:migrate，确认 0015 已记录，再发布 _worker.js 和前端；不能只替换前端。
3. 首次认证进入会安全继承可确认的旧身份并补齐缺失；不安全旧值显示历史待确认。普通刷新不会强制全部账号扫描。
4. 回滚先暂停并停止扫描/调度，再恢复 v2.10.1 整套产物。新增列/表可以保留，但旧运行时不识别 inventory:v2，新统计需重新采集；要精确恢复旧统计和任务状态，应停机恢复升级前完整备份。不要删除 CF 资源或变更加密密钥。

## 复验

三端 npm test / npm run typecheck / npm run lint，node scripts/check-db-schema.mjs，backend/frontend/worker npm run build，worker npm run build:scheduler。

先完成全部构建并冻结 FRONTEND_DIST，再运行 scripts/test-dashboard-consistency-ui.mjs、test-dashboard-ui.mjs、test-dashboard-scroll-ui.mjs、test-dashboard-auto-ui.mjs 及原资源脚本。PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE 使用现有隔离测试运行时；UI_REPORT 为新报告路径。基线用 git archive dd0e3a3… 导出，安装路径只做临时链接，分别传 BACKEND_ROOT / FRONTEND_DIST / BASELINE_UI=true。

容器：node scripts/test-docker.mjs <测试镜像> 和 DOCKER_REPORT=<新报告路径> node scripts/test-dashboard-docker.mjs <测试镜像>。只使用随机测试资源和合成传输，不运行生产部署命令。

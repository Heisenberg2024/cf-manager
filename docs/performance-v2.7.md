# CF Manager v2.7 性能审计与验收

## 基线与确认的瓶颈

基线：master / v2.6.0 / `43567701e1062837454b78125aa56f63935e40b5`。开始时工作区干净。先阅读 `PROJECT_MEMORY.md`、`docs/dns-performance.md` 和当前源码，再按 DNS、摘要、抽屉、Zone 四个单元实施。保留第一阶段 `ZoneDirectory`、`ReadScheduler`、SWR、身份指纹、实时归属校验、DNS LRU、虚拟列表、指标和安全批量执行器；无新依赖、Redis、数据库迁移或技术栈替换。未提交、推送或部署。

- DNS 首屏虽然只显示 20 行，仍等待整个 Zone 的 500 条分页。10000 条记录需要 20 次记录读取。
- Workers summary 每账号读取一次 GraphQL 用量、一次 Worker scripts 和 Pages projects 的各页；资源列表再重复 scripts/projects。前端等待全账号摘要才选第一个账号。
- Worker 版原 Pages 列表/计数只读第一页；两端失败计数为 0，用量服务也把失败变成零。
- Worker 抽屉打开即加载七组资源，其中变量还调用完整重部署配置；Pages 抽屉同时加载项目、域名、部署、R2、绑定和资源名称。
- Docker Workers / Pages DNS 自动操作使用 `getAllZones()` 后过滤；Worker 与两端 Tunnel 存在不带真实 Account 条件的 `/zones` 查询。
- `editPagesProject` 打印完整入参、env_vars 和返回配置；旧 Workers GraphQL 错误日志打印 curl/上游正文。
- DNS 灰色条来自 skeleton，记录表 loading 和域名列表 NSpin 还有遮罩。大记录数的移动端分页栏另有横向溢出，基线浏览器复现了页码不可点击。

## 改动单元与文件

| 单元 | 主要文件 | 行为 |
| --- | --- | --- |
| DNS 分页与范围 | `frontend/src/api/dns.ts`、`stores/dnsStore.ts`、`views/DnsView.vue`、`components/DnsBatchDialog.vue`；`shared/zoneDirectory.ts`、`dnsBatch.ts` | 首个 500 条窗口；小 Zone 完整快照，大 Zone 按需窗口；字段筛选、正确总数、内存页缓存；三种明确选择与签名预览；去遮罩和修复移动分页 |
| Workers/Pages 摘要 | `shared/workerResources.ts`、双端 `services/workerResourcesRuntime.ts`、`routes/workers.ts`；`frontend/api/workers.ts`、`stores/workerStore.ts`、`views/WorkersView.vue`、`components/DeployDialog.vue`、`App.vue` | 当前账号优先、其他账号逐项展示；共享列表与数量；用量独立；创建/删除/部署后定向失效；退出清理 |
| 抽屉懒加载 | `frontend/src/utils/drawerReads.ts`、`WorkerSettingsDrawer.vue`、`WorkerPagesSettingsDrawer.vue` | 页签首次按需读取，30 秒内复用；身份/世代隔离与取消；保存目标刷新；错误提示；Secret 输入清理与读取脱敏 |
| Zone 与日志 | `shared/accountZones.ts`、双端 Tunnel services/routes、Workers routes；Docker `pagesService.ts`、`workerService.ts`；双端 quotaTracker | 目标 Account 查询与实时写入归属校验；Tunnel 精确内容查询；删除配置调试日志；配额同步和摘要共享 GraphQL 缓存 |
| 同步与交付 | `scripts/sync-shared.js`、`docker/Dockerfile`、`.gitignore`、`CHANGELOG.md`、本文与 JSON、测试/基准脚本、两种语言消息 | 共享源生成双端副本，Docker 包含新增共享源；版本 2.7.0；无新增依赖/迁移 |

共享源仍是唯一真实来源，生成副本由 sync-shared 管理。`backend/src/routes/dns.ts`、`worker/src/routes/dns.ts` 的分页/签名/SSE 入口继续沿用，新增参数通过共享 `recordPageQuery` 生效，没有复制第三套路由。

## DNS 读取、选择与安全

初次请求 `page=1&perPage=500`，从 `total_count` 判断模式。100/500 条以内一次读取后保留完整快照、客户端分页和局部 CRUD；大型 Zone 首次只返回 500 条，同一窗口内翻 20/50/100 条页面无需网络，跨窗口才请求下一页。缺少有效大页总数时明确报错，不能把一页当整个 Zone。刷新保持当前页/筛选和可见旧数据，减小结果集后自动收敛页码。

页缓存只在 Pinia 内存，最多 60 个 500 条窗口，Fresh 30 秒，键包括本地 Account、Zone、域名、窗口和字段筛选。保留原完整快照的 30 Zone / 50000 条 / 单 Zone 20000 条限制；两个池合计有界（最多约 80000 条）。退出、凭证身份变化和写后按 Zone/跨凭证别名失效；已完成 Proxy/TTL 等不改变顺序或筛选归属的回执局部替换，创建/删除或改变排序/筛选字段才刷新受影响窗口。取消及失效世代阻止迟到页回填。Zone 从完整模式增长到分页时驱逐旧完整快照；分页局部更新提前返回之前必须执行完整快照别名失效，避免旧绑定复访显示旧数据或 Proxy 读取旧快照找不到新行。

搜索明确选择名称或内容字段，类型条件按 AND 组合，大小写不敏感。新只读和批量查询使用 `name.contains` / `content.contains` / `type` / `match=all`，预览再逐字段验证。旧 `search` 只读参数继续兼容。[Cloudflare DNS 文档](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/) 明确 search 面向用户，精确行为没有保证且可变化；本次核对的是官方契约和模拟匹配，真实 CF 搜索行为没有用生产凭证实测。

- **当前页/明确 ID**：仅勾选真实可见行，支持累积多页 ID；勾选单行会从范围选择切回明确 ID，不暗选未加载行。
- **当前筛选结果**：捕获当前确定性字段条件，服务端枚举匹配记录，显示完整签名目标后再确认；没有把当前窗口当全部。
- **整个 Zone**：不带筛选枚举完整 Zone，单 Zone 最多 10000 项，超限明确拒绝；测试验证 10000 项完整签名，没有截断。

三种范围都复用原 HMAC 15 分钟预览、认证、凭证/Zone 实时归属、0012 原子消费防重放、写前完整快照、SSE 和逐项回执。原跨 Zone exact-host 流程及 5000 项上限保留。当前页批量也接入同一预览，不再绕开快照。隐藏的旧 host/currentContent 不影响新范围，原 TTL/Proxy 值带入预览。少量明确 ID 直接 GET，较多 ID 扫描确定性分页并检查缺失/重复；缺失目标返回错误，不默默省略。执行只写签名确认的记录，新出现的记录不会被隐式加入。

批量写入不依赖页面缓存，不重试网络/5xx 等不确定写入；原有明确 429 有限重试保留。停止/断流后刷新并重新预览，不能重放已消费的计划。

## Workers/Pages 缓存、接口与指标

`WorkerResources` 复用第一阶段 scheduler（全局 6、同账号 2、后台最多 2、前台优先、30 秒读取截止）。列表缓存 30 秒，用量缓存 120 秒并按 UTC 日期隔离；键含真实 CF Account、本地绑定/凭证和认证/代理配置指纹。最多 1500 个资源条目且序列化估算预算 8 MiB，超过预算的单列表不保留，当前进程/Worker DB isolate 内有效。普通读取失败短暂缓存 5 秒，429 采用保守 5 分钟冷却，即使手动刷新也不会立即再冲击上游。缓存失效隔离迟到读取；一个消费者取消不影响其他共享消费者。

[Worker scripts 是 SinglePage 接口](https://developers.cloudflare.com/api/typescript/resources/workers/subresources/scripts/methods/list/)，只读取一次；[Pages projects 支持 page/per_page](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/)，两端都每页 100 条完整枚举后共享缓存。当前列表和摘要同时冷读共享相同任务。创建/删除/部署及未知写入后失效受影响绑定及同真实 Account 别名，独立的用量缓存保留；手动配额同步强制取实时用量再供摘要复用。

- 旧 `/workers` 数组、`/workers/summary` 全账号数组和 `/workers/usage` 保留；新增 `accountId` 范围、`refresh`；summary 可 `usage=false` 完全跳过 GraphQL。
- `/workers?details=true` 返回 `{items,states}`，旧数组模式不变。状态分别覆盖 Workers、Pages 和 usage；失败字段为 null，正常空列表为 0。前端显示未知/失败、保留成功的资源，不误清管理登录。
- 前端账号元数据先展示，当前账号列表立即发起，其他账号以两个渐进任务补齐。资源表使用虚拟滚动，前端列表缓存也有 8 MiB 估算预算；账号切换复用 30 秒有效内存列表；凭证变化、写后和退出失效。迟到列表、统计和账号元数据不能污染新账号/登录。
- 延续 `performanceMetrics` / API Logger，增加 `resource_lookup/hit/loaded/failed` 账号事件；既有请求汇总计入缓存命中、合并、CF 调用数、耗时、超时和限流。共享 scheduler 的排队/取消/合并事件继续使用原指标，CF transport attempt 仍逐次计数，不另建监测系统。

[Cloudflare 限流文档](https://developers.cloudflare.com/fundamentals/api/reference/limits/) 给出用户/账号 Token 1200 次/5 分钟、IP 200 次/秒，GraphQL 依成本且最高 320 次/5 分钟。继续尊重 Retry-After 和只对明确 429 重试；没有扩大原上游并发上限。大量账号冷统计整体完成时间可能增加，当前列表与缓存访问不再受它阻塞。

## 抽屉、Zone 与敏感数据

Worker 默认变量页只读 Settings bindings 和 Secret 名称（2 个前端接口）；Schedules / Domains / Subdomain / Settings / Script / Deployments / Routes 在对应页签读取。Settings 读取可供变量与设置页共享；Zone 只在路由或域名编辑需要时读取。Pages 默认信息只取 Project（1 个前端接口），Env/Bindings 可共享 Project；存储名称与 R2 只在绑定页读取，Domains/Deployments 按页签读取。

抽屉的缓存仅内存，键含本地 Account 与资源名称，30 秒复用、30 项上限，关闭取消未完成请求，变更身份/销毁清理。缓存克隆防止编辑污染，递归移除 secret 类型的 value/text/key_base64；不把 Secret 输入写入缓存或 localStorage/IndexedDB。关闭清空输入、加载状态和旧资源；旧 Script/R2 错误也检查请求身份。保存后强制刷新对应页签；Pages 环境变量合并前实时读取 Project，不用缓存配置当写入快照。

`accountZones` 对启用 DNS 的绑定复用原目录；只启用 Workers/Tunnel 的绑定走目标 `account.id` 条件查询，由 CF 判定实际权限，避免错误要求用户新增本地 DNS 开关。两种路径均过滤真实 Account，保留本地 Account/credential 身份。域名匹配优先最长后缀；Pages 自动 DNS、Worker route、Tunnel 向导和补偿删除实时 GET Zone 验证归属，缓存只供展示/定位。Tunnel hostname 使用 `type=CNAME&content.exact`，不再下载所有 CNAME 内容。

Pages edit 的三个配置日志直接删除，正常配置调用/返回值保留；同时固定 SDK 的 account_id 为选中的绑定，避免完整请求体覆盖路径 Account（Worker 版原来使用固定路径），配置字段不变；Workers GraphQL 用共享读取替代旧正文/curl 日志。新增日志仅身份、资源操作、字段/调用计数、时间和状态，不记录 Token、环境变量/Secret、完整请求或上游原始错误。既有 Pages 域名自动 DNS 业务在 Docker 侧保留，Worker 侧原域名 API 行为保持。

## 可重现的模拟数据

所有值都是**本地合成**，不是生产 P95。Workers 基准只读导出基线源码、复用相同 transport fixture，真正执行两版路由/服务；每个场景 10 次冷样本（P95 采用该 10 样本中的最大值），5 次同时冷请求另计。快账号每上游 2ms，60 账号场景每 5 个一个 20ms 慢账号、每 7 个一个 403 账号。DNS 浏览器基线则只读导出并构建旧前端，与新前端使用同一个 HTTP fixture、Chromium 与计时方法。没有 git reset、依赖安装或生产请求。

原始报告：`performance-v2.7-baseline.json`、`performance-v2.7-ui-before.json`、`performance-v2.7-ui.json`。

| Workers 场景 | 优化前 | 优化后 |
| --- | --- | --- |
| 20 账号 冷摘要 + 当前列表 CF 调用 | 62 | 60 |
| 20 账号 缓存命中 CF 调用 | 62 | 0 |
| 20 账号 5 个同时冷摘要 CF 调用 | 300 | 60 |
| 20 账号 当前账号可读取时间 | 13.42ms | 3.11ms |
| 20 账号全统计 P50 / P95 | 13.46 / 34.75ms | 36.71 / 53.24ms |
| 60 账号 冷摘要 + 当前列表 CF 调用 | 182 | 180 |
| 60 账号 缓存命中 CF 调用 | 182 | 0 |
| 60 账号 5 个同时冷摘要 CF 调用 | 900 | 180 |
| 60 账号 当前账号可读取时间 | 78.86ms | 3.58ms |
| 60 账号全统计 P50 / P95 | 75.12 / 85.52ms | 272.50 / 274.25ms |

同时冷请求调用下降 80%，有效缓存访问不调用上游。单次全账号冷统计只减少当前列表的两个重复请求；受控调度使全统计变慢，不能声称全账号完成延迟下降。当前账号不等待全统计，60 账号当前可读取等待从 78.86ms 降至 3.58ms（该 fixture）。

| DNS 视口 / 记录数 | 首屏 前 → 后 | 首次返回记录 前 → 后 | JS 堆 前 → 后 | 翻页响应 前 → 后 |
| --- | --- | --- | --- | --- |
| 1440px / 100 | 106 → 129ms | 100 → 100 | 17.88 → 18.07 MiB | 59ms → 58ms |
| 1440px / 1000 | 104 → 110ms | 1000 → 500 | 18.06 → 18.10 MiB | 60ms → 54ms |
| 1440px / 10000 | 348 → 117ms | 10000 → 500 | 19.68 → 18.12 MiB | 52ms → 56ms |
| 390px / 100 | 99 → 114ms | 100 → 100 | 16.41 → 16.60 MiB | 53ms → 55ms |
| 390px / 1000 | 99 → 99ms | 1000 → 500 | 16.59 → 16.63 MiB | 旧页码超出屏幕 → 53ms |
| 390px / 10000 | 342 → 111ms | 10000 → 500 | 18.22 → 16.65 MiB | 旧页码超出屏幕 → 53ms |

DNS 首屏 HTTP 请求两版均为 1 次；区别是旧响应等待/包含整个 Zone，新响应仅首个窗口。CF 记录分页调用为 100 条 1→1、1000 条 2→1、10000 条 20→1（按实际 500 条页契约；另需同样的实时归属 GET）。100 条没有额外探测或分页请求，小样本首屏波动不能认定生产加速/退化。10000 条首次传输下降 95%，框架固定内存占多数，因此整个页面 JS 堆下降幅度小于记录传输降幅。

- 浏览器 20 账号：当前列表首屏 190ms；Worker 初始页 2 个读取，Pages 初始页 1 个读取；其他页签未打开不请求。后台统计尚未全部完成的调用量只作截图时快照，不当总调用量。
- 浏览器 60 账号：当前列表首屏 242ms；Worker 初始页 2 个读取，Pages 初始页 1 个读取；其他页签未打开不请求。后台统计尚未全部完成的调用量只作截图时快照，不当总调用量。

浏览器矩阵还覆盖 1000 Zone 可见 DOM 少于 40 行、首窗内翻页不请求、跨窗与短期复访、第 2/500 页合计 40 个明确目标、远端字段筛选与总数、范围选择后勾选单条改回 ids、账号连续切换、页签复用、Secret 不展示及迟到响应。所有请求数、内存和耗时均只代表该 fixture。

## 验收命令与结果

- 原 296 项全部保留，新增 61 项：backend **169**、worker **125**、frontend **63**，合计 **357**；通过。
- 三端 `npm run typecheck` / `npm run lint`：通过，Lint 0 errors；保留存量 any/样式 warning。
- backend/frontend build 与完整 Worker build（含 /admin 和 ZIP）：通过；保留前端大 chunk 提示。
- `node scripts/check-db-schema.mjs`：通过，无新迁移。
- ARM64 `cf-manager:codex-v27` Docker 镜像构建、`scripts/test-docker.mjs`：通过。包括 UID 1000、只读/降权、旧库迁移、持久化、日志路径/stdout、主机绑定和不可写目录错误；测试资源隔离且清理。
- 原 DNS/套餐/浮层/缩放/reduced motion/长列表滚动及第一阶段性能浏览器脚本：通过；新增 v2.7 桌面/移动矩阵通过。浏览器需 macOS Mach 端口，沙箱外运行隔离 Chromium；未操作现有用户浏览器。
- 双端新增 HTTP 和共享契约验证旧数组、账号参数、Pages 分页、正常空值与失败 null、凭证失败隔离、只读合并、取消、独立过期/冷却、失效别名、实时归属及敏感日志。

```sh
node scripts/sync-shared.js
npm test --prefix backend
npm test --prefix worker
npm test --prefix frontend
npm run typecheck --prefix backend
npm run typecheck --prefix worker
npm run typecheck --prefix frontend
npm run lint --prefix backend
npm run lint --prefix worker
npm run lint --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
npm run build --prefix worker
node scripts/check-db-schema.mjs
BUILDX_CONFIG=/private/tmp/cf-manager-buildx docker build -f docker/Dockerfile -t cf-manager:codex-v27 .
node scripts/test-docker.mjs cf-manager:codex-v27
node scripts/benchmark-v2.7.mjs
# PLAYWRIGHT_MODULE 指向已安装包；不引入生产 E2E 依赖。
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/benchmark-v2.7-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-v2.7-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-performance-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-plans-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-scroll-ui.mjs
```

## 未解决边界、风险与回滚

1. 没有真实 CF/D1、代理网络、Linux AMD64 或生产 P95 证据；需要部署后只读采样，不能把模拟值当生产收益。
2. 大型只读全量旧接口仍可能耗时/触及 invocation 限制；新 UI 使用窗口。[Worker 限制](https://developers.cloudflare.com/workers/platform/limits/#subrequests) 中 Free 单 invocation 50 个外部 subrequests、Paid 默认 10000 的既有限制仍适用，10000 项完整预览通过不代表一次 invocation 能完成 10000 项写入。大型写批次需缩小范围或使用 Docker，未知结果不得重发；分批可恢复执行留待单独安全设计。
3. Workers 冷全统计因限流调度更慢，性能目标通过当前账号优先与缓存达成；缓存不能消除第一次读取所有账号的必需调用。
4. Worker 缓存仅 isolate/DB 内存，跨 isolate/重启不共享；没有增加非必要服务或改为最终一致性 KV 做写入判断。
5. 只读快照在 TTL 内可能过期，刷新可重读；外部写入无法即时通知内存缓存。危险操作仍实时校验；签名预览只执行确认时列出的快照。
6. 大预览 payload/签名和前端对象有成本，限定单 Zone 10000 项并要求明确范围；预览不是无限全量操作许可。

旧 DNS 全量数组、旧 Workers/summary 数组与有效参数保持兼容；失败计数 null 是有意纠正误导，外部消费者应检查状态/空值。新前端需与新双后端版本配套发布，回滚时一起恢复 `4356770` 对应 Docker/Worker 及前端包，保留数据库、0012 消费记录和 ENCRYPTION_KEY；回滚后刷新列表，不清业务数据。未增加迁移，无需数据格式降级。

工作区没有自动提交。可按四个单元拆分审查/提交：DNS（shared DTO + frontend + 契约）、Workers 摘要/配额（shared runtime + 双路由 + store/view/部署刷新）、抽屉（API signal + drawerReads + 两组件）、Zone/日志（accountZones + 双端 Tunnel/Worker route + Pages）；共享同步/Docker COPY 与使用它的模块同时纳入，最后再纳入版本与验收报告。模块回滚应同步恢复其前端/双端适配，不只撤其中一端。

## 下一阶段 Storage 建议

先采样现有 API 指标，按账号统计 KV/D1/R2 真实调用和延迟。沿用 scheduler/身份隔离：KV/R2 使用上游 cursor 按需读取与缓存已访问页，避免为统计总数全量扫描；D1 表列表、结构、COUNT 和数据分页分开，查询结果设置体积/行数上限；对象预览/下载及绑定资源按需获取，写后只失效相关命名空间/表/bucket/prefix，配置读取不能用于危险写入快照。随后复用 20/60 账号、慢/失败、同时冷读、取消和写后失效 fixture 做双端契约与浏览器验收，先测量再选择缓存周期，不以增加并发作为优化。

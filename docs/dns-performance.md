# DNS 性能优化第一阶段（2.6.0）

> 本文保留第一阶段验收事实；2.7.0 已接入自适应记录窗口和明确跨页范围，当前架构及验收见 [第二阶段报告](performance-v2.7.md)。

## 已确认的瓶颈

基线为 `7d45afd49ca307ca3264ef8c23ab5e3a7da51b6a`。进入 DNS 页原先先等 `/accounts` 与 `/credentials`，再请求全量 `/dns/domains`；精确 accountId/zoneId 操作仍调用 `findAccountByDomain → getAllZones`。全量缓存是一个 300 秒的成功数组，单账号失败返回空数组后也会进入缓存；缓存过期时没有请求合并。

记录页切换会下载整个 Zone；CRUD 和 Proxy 成功后再下载一次。原读取每页 100 条，10000 条记录需要 100 次分页调用。跨 Zone 预览本来已按 `name.exact` 查询，每个 Zone 的归属和同名快照各读一次；执行前的逐条完整快照比较是安全约束，应保留。

未发现本地 SQLite 查询或框架是上述等待的主要原因。没有更换技术栈、数据库或增加 Redis。

## 可重现结果

`scripts/benchmark-dns.mjs` 将旧提交只读导出到临时目录，复用本地已安装依赖，以同一个 Vitest fixture 分别执行旧实现和当前实现，结束后清理临时目录。20 个账号、每账号 30 个 Zone、每页模拟延迟 5ms；没有实际 Cloudflare 请求。原始数据见 `dns-performance-baseline.json`。

| 场景 | 优化前调用数 / 时间 | 优化后调用数 / 时间 |
| --- | --- | --- |
| 全量冷加载 | 20 / 42.71ms | 20 / 43.27ms |
| 全量缓存命中 | 0 / 1.34ms | 0 / 0.32ms |
| 精确 Account/Zone 冷定位 | 20 / 41.66ms | 1 / 5.89ms |
| 10 个同时到来的全量冷请求 | 200 / 53.37ms | 20 / 41.64ms |

精确定位调用数下降 95%，此模拟样本耗时下降约 86%；并发冷请求调用数下降 90%。全量冷加载并未更快，新增身份摘要和调度有开销；本阶段主要通过按需加载、渐进展示和减少重复工作改善实际操作等待。表中时间为单次本地样本，不能外推到生产延迟。

双端契约还验证了 10000 条记录完整读取只需 20 个 500 条分页；旧实现的 100 页来自已审计的 `per_page=100`，未伪造旧生产延迟。浏览器合成场景为 20 账号 / 1170 Zone / 10000 记录：单账号首屏仅请求该账号；600 个 Zone 的可见 DOM 行少于 40，末项与第 20 个账号组可达；失效的已保存绑定回退至可用 DNS 账号；账号元数据只取一次，不等待延迟的凭证名称；缓存复访无 GET；Proxy 成功无全量 GET，失败回滚；刷新保留旧表，慢账号不阻塞其他账号。桌面/移动端首个列表约 160–250ms（含浏览器启动导航后的应用初始化，非生产值）。

复验命令：

```sh
node scripts/sync-shared.js
node scripts/benchmark-dns.mjs
# 可指定旧提交及报告输出路径，使用 execFile 参数，不拼接 shell。
node scripts/benchmark-dns.mjs 7d45afd49ca307ca3264ef8c23ab5e3a7da51b6a /private/tmp/dns-benchmark.json
npm test --prefix backend
npm test --prefix worker
npm test --prefix frontend
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-performance-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-plans-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-scroll-ui.mjs
```

## 主要改动文件

- 共享核心：`shared/zoneDirectory.ts`、`readScheduler.ts`、`accountDiscovery.ts`、`dnsRecord.ts`；生成副本仍由 sync-shared 管理。
- Docker 后端：`backend/src/routes/dns.ts`；`services/accountRouter.ts`、`cfFactory.ts`、`dnsService.ts`、`zoneService.ts`、`dnsBatchRuntime.ts`、`dnsDirectory.ts`、`performanceMetrics.ts`；`middleware/apiLogger.ts`、`errorHandler.ts`。
- Worker：`worker/src/routes/dns.ts`、`accounts.ts`；`services/cfApi.ts`、`credentials.ts`、`dnsBatchRuntime.ts`、`dnsDirectory.ts`；`index.ts` 与 API/错误中间件。
- 前端：`frontend/src/stores/dnsStore.ts`、`views/DnsView.vue`、`api/dns.ts`、`App.vue`、`main.ts`、`utils/demoAccounts.ts`、`components/DnsZoneList.vue`、`DnsZoneRow.vue` 和两种语言消息。
- 验证与打包：三端 DNS 契约/状态/归属/写入测试，`shared/tests/dnsPerformance.contract.ts`、`scripts/benchmark-dns.mjs`、`test-dns-performance-ui.mjs` 及原 DNS/套餐/滚动脚本；`scripts/sync-shared.js`、`docker/Dockerfile`、`.gitignore`、`CHANGELOG.md` 和 DNS 文档。`PROJECT_MEMORY.md` 为本地项目记忆，已更新，仍按原 `.git/info/exclude` 不纳入提交。

## 数据访问和接口

- `shared/zoneDirectory.ts`：本地账号取最新绑定 → 检查启用、有效绑定及 DNS 功能 → 直接 GET `/zones/:zoneId` → 比较真实 Account ID、Zone ID 与域名；写操作也走实时归属校验，SDK body 中的 zone_id 不能覆盖已验证目标，Record ID 限制为单路径段，拒绝目录跳转。缺少身份的旧调用仍枚举并检测同名歧义；部分账号读取失败时返回 503，不能猜测唯一归属。
- 新 `GET /api/dns/accounts/:accountId/domains?refresh=true|false` 返回 `{zones,meta}`，meta 包含 accountId、state、fetchedAt、durationMs、可选安全错误分类。前端当前账号先请求，选择全部时并发 3，完成一个展示一个，始终按账户元数据顺序合并，不能让响应先后改变批量目标顺序；选择全部搜索结果前立即应用待防抖搜索。凭证名称异步补齐，身份仍为“账户名称｜凭证名称”。
- 旧 `GET /api/dns/domains` 保持数组，可选 accountId；部分成功为 206，`X-DNS-Failed-Accounts` / `X-DNS-Stale-Accounts` 标记账号。没有把失败空数组缓存为完整成功。正常空账号仍可成功缓存。
- Zone 字段只保留 id、name、status、paused、真实 account、实际 plan、NS 和本地绑定/凭证身份。Zone List 每页保持 50，[官方接口上限](https://developers.cloudflare.com/api/resources/zones/methods/list/)。
- 记录默认仍返回完整数组，保留客户端类型/多字段关键字筛选、当前页与全部筛选结果选择的原有含义。显式传 `page` 时返回 `{records,meta:{...result_info,scope:'page'}}`；page 1–1000、perPage 1–500，支持 type/search，不能把这一页解释成整个 Zone。完整读取每页 500，遵循[记录接口](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/)。

## 缓存、调度与失效

Zone 快照最多 500 个本地绑定，Fresh 30 秒、Stale 300 秒，按账号 LRU；版本包含真实 CF Account、credentialId、账号更新时间、认证密文、认证类型和代理配置的 SHA-256 摘要。请求键再加入路径（含 Zone ID/分页）与失效代数，不记录或持久化密文/键。单账号 Singleflight 防止冷加载和过期击穿，成功快照可 SWR；前端先展示 stale，再以受控并发加入服务端实时更新。强制刷新失败明确报错，保留的旧列表有失败/可能过期提示。

Zone 创建、删除、套餐、暂停状态变化定向失效本地绑定及已缓存的同 CF Account 凭证别名；删除/暂停即使写入结果未知也失效。账号/凭证 CRUD 通过现有清缓存入口失效，最新启用/认证信息仍从数据库读取。失效期间的旧查询不能重新填入新缓存。Worker 仅用 isolate 内按 DB 对象隔离的内存缓存，进程/冷启动会丢失；不再读取旧 `dns_zones_all` KV，也不以 KV 最终一致性决定写入归属。

`shared/readScheduler.ts` 限制全局 6、同账号 2、后台 SWR 最多 2；排队的前台请求优先，相同 GET 可合并。一个消费者取消不影响其他消费者；全部取消会中止对应任务。每个读取任务含排队的截止时间 30 秒，上游 transport 单次 15 秒；多页列表每页分别受截止控制，Express 记录读取在客户端断连时中止后续分页，Worker 传递 Request signal。超长总列表仍可能超过客户端整体超时，应使用分页接口或缩小范围。

现有 `createCfRequest` 只重试明确 429，最多两次；尊重 Retry-After，最多等待 5 秒，超过则返回限流错误，不提前发送。[Cloudflare 限流说明](https://developers.cloudflare.com/fundamentals/api/reference/limits/)；网络、5xx 和结果不确定的写入不重试。已检查本地 Cloudflare SDK 默认 maxRetries=2（包含网络失败/408/409/429/5xx）；DNS SDK 写入显式设为 0，避免隐藏重复提交。非 DNS SDK 调用维持原行为。原 HTTP/SOCKS5/Resin 代理选择和 agent 缓存保持，原生 fetch 的连接池复用保持；未对真实代理/TLS 建连做性能归因或更改配置。

DNS API（含 SSE）设置 no-store，防止浏览器持久缓存敏感响应。Proxy 保留旧 success 回执并新增 record 完整回执，旧版回执回读失败回滚。首次读取未完成的写入会重新取得完整快照，不能把局部回执当整个 Zone；缺少 Account/Zone 身份的旧调用不缓存。客户端记录仅存 Pinia 实例的内存 LRU：30 个 Zone、总 50000 条、单 Zone 超过 20000 不缓存；Fresh 30 秒，最多展示 120 秒旧快照并重读。成功 CRUD 用完整服务端回执局部更新/删除；Proxy 先替换行，失败恢复原值并驱逐不确定缓存。刷新、批量完成/断流只失效受影响 Zone，含跨凭证别名；账号版本变化及退出/登录失效清除敏感快照，旧会话写入不能污染新会话。域名选择只保存本地账号选项，DNS 内容不写 localStorage/IndexedDB。

## 指标与安全

复用 API Logger，Express 用 AsyncLocalStorage 汇总每个本地请求的 durationMs、upstreamCalls、cacheLookups、cacheHits/cacheHitRate、staleHits、merged、rateLimited、timeouts；单事件包含账号、排队/执行耗时、cache hit/stale/load/failure、transport attempt/status/429 及 SDK 写入计时（429/504 也纳入计数）；proxy 标签仅表示账号显式代理配置，不能当作实际代理链路耗时。Worker 用已有 API Logger 的结构化请求时间和同类账号事件。日志仅保存身份、方法、路径、状态及计数；查询参数、认证头、密文、DNS/TXT 内容和上游原始错误消息不入日志，界面仍获得具体错误。

`cf_attempt.durationMs` 计到响应头就绪，包含连接和上游首字节等待；`read_finished.durationMs` 包含响应体读取/解析和有限重试，`queueMs` 单独记录排队，SDK 写入也有完整操作耗时。尚不能独立分离 DNS/TCP/TLS/代理握手各阶段，没有将其冒充 proxy-only 时间。分页与重试以逐次事件区分，前端初始化/渲染以浏览器 fixture 计时区分。真实 CF/D1、不同 Worker isolate 的缓存命中和真实代理性能需部署环境只读采样。

跨 Zone 批量仍保留 HMAC 15 分钟预览、0012 防重放、执行前归属与快照、并发 3、SSE、审计、逐项回执、未知结果不重发。只读查询加入同一调度/合并机制，写入直接使用原请求。没有使用 DNS Batch API，也没有省掉必要的写前重读。

## 验收、风险和回滚

三端原有测试和新增缓存/调度/前端状态测试、三端类型检查与 lint（0 errors，存量 warning 保留）、backend/frontend/完整 Worker 构建、schema check、ARM64 Docker 镜像构建及隔离 Docker 启动/旧库/持久化矩阵已执行。浏览器覆盖桌面/移动端、深浅主题、原生缩放/reduced motion、批量/套餐/浮层/滚动及上述大规模场景。最终通过 backend 146 / worker 105 / frontend 45，合计 296 项；详细边界也记录于 PROJECT_MEMORY.md。没有真实 DNS 写入或生产部署，没有声称真实 D1 或 Linux AMD64 已验收。

风险：内存快照有限时间内可能过期，界面明确显示并保留实时刷新；实时归属读取仍依赖 Cloudflare 权限和网络，不能省掉；旧全量接口或极大 Zone 的完整记录读取可能触及 Worker Free 子请求/客户端超时；新增分页接口已提供，但界面本阶段继续完整读取，以避免改变“整个 Zone 全部”的安全语义。

本阶段无数据库迁移、无新依赖。回滚发布的前后端一起恢复到旧镜像/Worker 包，保留原数据卷与 ENCRYPTION_KEY；旧版可能继续读遗留 KV 快照，回滚后应手动实时刷新域名列表，或移除仅 `dns_zones_all` 缓存键。不要清业务数据或修改凭证。基准脚本只导出历史提交，不执行 git reset/add/commit。

下一阶段：按真实只读日志分位数确定慢账号/代理和最常见大 Zone；实现记录页的渐进服务器分页，同时设计跨页批量选择的显式范围与预览；按权限/version 设计跨 Worker isolate 的只读快照共享；将已稳定的只读调度按模块逐步扩展到 Workers/Storage。避免在缺少生产证据时扩大并发或改变写入语义。

# CF Manager v2.8：Zone 设置与 Storage 验收

日期：2026-10-14。基线：`79978a9a2f5e22571f4a3856f28432d4bc52fae7`（v2.7.0）。本报告中的延迟、P50/P95、调用量、内存和大规模数据全部来自**本地合成模拟**，不是生产 Cloudflare 指标；未提交、推送或部署。

## 审计与最终实现

| 单元 | v2.7 问题 | v2.8 行为 |
| --- | --- | --- |
| A：Zone 设置 | 设置没有独立快照；缓存页签不主动读取；切换页签重复 GET；刷新覆盖表单；保存两次完整读 | 两页签按需共用设置快照，DNS 首屏不预加载；30 秒 Fresh / 180 秒 Stale、SWR、手动刷新、旧响应隔离；草稿按身份隔离，刷新只更新干净字段 |
| A：保存与动作 | 无字段冲突反馈、未知写入及重复提交不清楚；状态完成后使用可变当前账号刷新 | 仅提交差异；实时 Account/Zone 归属及逐项权限/值校验；检查全部基线后 PATCH；逐项确认、部分结果、未知不重发；SSE 输出实际进度，旧 JSON 保留；状态回执只更新对应 Zone，CDN purge 不失效管理快照 |
| B：R2/KV | Bucket/Object Cursor 未完整接入；Worker 把官方 R2 数组当对象；KV 累积无限、复访重复读 | 统一 Cursor/截断校验，空页有下一游标仍继续；去重对象/目录，保留完整 Key；只缓存访问页，取消旧读取；虚拟滚动与最近 2000 项窗口；写后只失效相应 namespace/bucket 及同 CF Account 别名 |
| C：D1 | 开头正则漏 CTE/注释/多语句/PRAGMA；Worker 忽略 allowWrite；审计记录 SQL；结构名称被截断 | 双端共用词法边界及限制语句子集，默认只读，写入严格 require `allowWrite === true`；Demo 只读；实时 GET 验证 DB 归属；不重试 SQL；仅审计类型/状态/计数摘要 |
| C：读取 | 元数据重复读，任意表 SELECT 无稳定顺序，结果不受控 | DB/表/Schema 30 秒内存缓存；普通表隐藏 rowid、WITHOUT ROWID 的 TEXT/INTEGER 主键 keyset 分页；自定义 SQL 分开；未缓存的只读 SQL/表数据也走原 scheduler；行数、响应、参数限制 |
| D：集成 | 名称带 Cloudflare 生成的 possessive 后缀 | Account 标签及新保存的本地名称移除完整 `'s Account` 词组；不改 CF 真实 Account、绑定 ID、历史归属或已有 Credential 名称 |

浏览器复现并修复了一个额外原因：初次渲染空表单后，直接修改缓存中的 raw 对象不会重新触发 Dirty computed。激活快照时重新绑定 Vue proxy，并用“先读空 Dirty、再加载、再编辑”的测试保护。Dirty 草稿不因容量压力被驱逐；已有 30 个未保存草稿时，新 Zone 的设置暂时只读，提示先保存/取消。KV 编辑器捕获打开时的 Account/Namespace，资源切换关闭旧编辑器；创建回执不能关闭新账号的弹窗。

## 缓存、调度和安全边界

- 复用 `ReadScheduler`：全局 6、同账号 2、后台最多 2，读任务含排队 30 秒截止；未提高并发。Zone 逐项降级在一个原调度槽内顺序读取，避免嵌套调度或并发放大。
- 服务端快照通过 `bindingSignature` 隔离本地 Account、credentialId、真实 CF Account、认证密文/类型/配置与代理版本，再加 Zone 或 Storage 资源/Prefix/Delimiter/Cursor。定向失效同时隔离迟到填充。Worker 只在当前 isolate/DB 对象内复用；无 Redis、KV 持久快照或新依赖。
- Zone 服务端最多 500 条 / 8 MiB 序列化估算预算；Storage/D1 元数据共享最多 300 条 / 8 MiB。客户端 Zone 快照/草稿分别有 30 条与 1 MiB 预算；已 Dirty 的小枚举草稿保留。Storage 访问页最多 60 页 / 8 MiB，活动窗口最多 2000 项（对象元数据约 4 MiB），目录前缀亦限 2000。刷新可从头浏览，不隐式全量下载 Bucket/Namespace。
- 客户端快照与编辑值仅在会话内存；退出/认证失效清理，账号/凭证版本改变失效；Storage 组件销毁取消读取并清缓存。KV Value 和 D1 查询结果不进入页快照或持久存储；图片按需下载，关闭释放 Object URL。
- 写前所有归属/权限检查使用实时数据，缓存只供展示。保存目标及认证绑定在开始时捕获，异步完成不读取新选择作为写入目标。SQL、上传、删除失败或未知不会自动重发；部分回执保留。
- D1 SQL 至多 100000 UTF-8 字节；参数至多 100 个标量 / 2 MiB；上游响应至多 4 MiB，支持原生 Web Stream 和 node-fetch 代理流/Buffer；自定义结果最多 1000 行并标记截断。表浏览每页 1–200（UI 100），不自动改写用户 SQL。
- keyset cursor 含 Account/credential/DB/表及 Schema hash（含 schema_version），使用参数绑定；不支持无法确认的排序、完全遮蔽 rowid 或不安全主键类型。大于 32 KiB 的游标明确拒绝。表列表超过 1000 项明确要求过滤 SQL，不把截断结果当完整列表。
- SQL 检测是保守的**限制子集分类器，不是完整 SQLite parser**；SQLite/Cloudflare 最终校验语法和权限。支持 SELECT/VALUES、只读 CTE/EXPLAIN、安全 PRAGMA；明确授权后可执行常见单条 INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP/REINDEX/ANALYZE 与受控 PRAGMA。多语句、事务/ATTACH 控制、未知 PRAGMA、IO/扩展执行函数和无法确定的语句拒绝，给出原因。

## Cloudflare API 与旧接口兼容

核对 [官方弃用说明](https://developers.cloudflare.com/fundamentals/api/reference/deprecations/#2026-07-27)：Zone Settings 批量 GET/PATCH 于 2025-04-23 弃用，停用日延长至 **2027-03-31**。本版保留可用的单次完整 GET；明确 404/405/410/501 或非法/空响应才切换逐项 GET，能力按认证指纹与 Zone 短期复用。403/429/网络失败不当成停用证据；保留旧快照并提示。降级仅读取两个页面使用的 11 个仍支持字段，不查询所有设置。

保存从未使用已弃用 Bulk Edit。默认逐字段 GET 预检 → PATCH → GET 确认；没有修改直接返回，不读/写设置。旧 flat JSON body 及 JSON 回执仍支持，新前端用 `{changes,baseline}` 与 SSE；基线冲突停止拟议写入，冲突检查是**非原子**，Cloudflare 没有被包装成 CAS/强事务。

| 字段 | 核对后的处理 |
| --- | --- |
| SSL | off / flexible / full / strict；保留真实返回与 editable |
| HTTP/2、HTTP/3、0-RTT、Always Online、HTTPS、Development Mode | on/off；0-RTT 路径为 0rtt；按实际 editable/缺失/错误显示，不猜套餐权限 |
| HTTP/2 Free | [官方说明](https://developers.cloudflare.com/speed/optimization/protocol/http2/)称 Free 不能关闭；不按本地套餐猜值，以 CF editable 拦截 |
| Security Level | 保留 API 兼容枚举；[当前官方说明](https://developers.cloudflare.com/waf/tools/security-level/)指出基础防护自动管理，API 主要用于 Under Attack；旧敏感度不能被宣称为新的防护强度保证 |
| Cache Level / Browser TTL | basic / simplified / aggressive；TTL 使用真实数值及服务端验证，套餐是否允许由 CF 回执确定 |
| Minify / Brotli | 官方已弃用；仅旧列表返回时只读兼容显示，不逐项查询或写入 |

[R2 Objects 官方格式](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)是 `result` 数组，目录位于 `result_info.delimited`；旧对象 envelope 同时兼容。`is_truncated=true` 必须有推进的 Cursor，空页不终止；明确 false 不使用残余游标。Bucket 新 `paged=true` 返回 DTO，旧无参数数组接口完整枚举 Cursor 并有安全上限。KV 旧 keys/cursor 保留，追加 is_truncated/meta。

[D1 query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)仍由 CF 的 D1 Read/Write 权限兜底；[SQLite EXPLAIN](https://www.sqlite.org/lang_explain.html)不能确保 PRAGMA 在 prepare 时没有效果，因此没有将任意 EXPLAIN 当成安全读取。D1 写授权、危险语句拒绝和结果上限是有意收紧；调用者需前后端配套升级并逐条明确授权。

## 可复现的优化前后结果

Zone 比较实际执行旧共享实现及原 ZoneDirectory.wrap；两版都包含 v2.7 已有调度器，因此原本已存在的并发合并不计作新收益。Storage 比较真实导出的 v2.7 Docker storageService 与新共享服务，复用 2ms transport 与本地 SQLite。每个冷场景 10 次，P50 为第 5 个排序样本、P95 为最大样本；不是生产统计。所有表均排除相同的实时归属 GET；真实 HTTP 还需该检查。

| 场景 | 前 → 后 CF 调用 | 前 → 后耗时（模拟） |
| --- | --- | --- |
| 20 账号 Zone 有效快照复访 | 20 → 0 | 9.60 → 0.45ms |
| 20 账号 Zone 冷 P50/P95 | 20 → 20 | 9.51/11.71 → 9.82/10.00ms |
| 60 账号 Zone 有效快照复访 | 60 → 0 | 23.51 → 2.00ms |
| 60 账号 Zone 冷 P50/P95 | 60 → 60 | 22.76/23.98 → 25.73/29.83ms |
| 20 账号 D1 元数据复访 | 40 → 0 | 2.84 → 1.27ms |
| 20 账号 D1 元数据冷 P50/P95 | 40 → 40 | 2.72/2.88 → 20.23/22.26ms |
| 60 账号 D1 元数据复访 | 120 → 0 | 3.11 → 3.91ms |
| 60 账号 D1 元数据冷 P50/P95 | 120 → 120 | 4.51/6.08 → 54.22/62.73ms |

- 10 个相同冷 Zone 设置请求：两版均为 **1** 次（原 Singleflight 保留）。无变化保存：设置 GET **2→0**、PATCH **0→0**。
- 单字段保存为设置 GET/PATCH **3→3**；两字段由旧整列表 4 次变为精确字段 6 次，三字段 5→9。新策略减少整配置读取/覆盖风险，并提供冲突/独立回执，不能声称所有保存的请求数都下降。
- R2 首次对象响应 **1000→100**、两版均 1 次（1000 是此 fixture 的默认，不是对所有 CF 默认值的断言）；KV 已访问页复访 **1→0**。
- 10000 KV Keys 完整逐页模拟两版均 100 次；旧可见累积 10000 行，新窗口 2000 行，序列化可见数据 **617782→124002 字节**。实际内存还有框架、页快照、字符串和 GC，不把该值当整个浏览器堆。

| Zone 容量/混合场景 | 复访调用 前→后 | 新缓存条数/估算字节 |
| --- | --- | --- |
| 20 账号 / 100 Zone | 100→0 | 100 / 229200 |
| 20 账号 / 1000 Zone | 1000→500 | 500 / 1146000 |
| 20 账号 / 20 Zone，慢/403 混合 | 20→2 | 18 / 41256 |
| 60 账号 / 100 Zone | 100→0 | 100 / 229200 |
| 60 账号 / 1000 Zone | 1000→500 | 500 / 1146000 |
| 60 账号 / 60 Zone，慢/403 混合 | 60→8 | 52 / 119184 |

混合 fixture 每 5 个账号一个 20ms 慢账号、每 7 个一个 403；失败隔离，成功空值和读取失败分开。1000 Zone 超过 500 条缓存容量，因此不能全部命中。D1 冷全账号读取因为从无界并发改为受控调度而更慢；收益来自当前账号按需和有效快照复访，不声称冷全量更快。

原始文件：`performance-v2.8-baseline.json`、`performance-v2.8-storage.json`、`performance-v2.8-ui.json`、`performance-v2.8-v27-regression.json`。浏览器 1440/390px × light/dark 使用 60/20 账号、1000 Zone、10000 对象/Keys/行的 fixture；只按需打开部分页，不把全部资源驻留在浏览器。Zone 交互时间包含导航、点击与保存，并非单独首屏 P95；堆值是一次 GC 状态快照，不能做生产结论。

## 验收

| 项目 | v2.7 基线 | v2.8 最终 |
| --- | --- | --- |
| Docker tests | 169 | 252 |
| Worker tests | 125 | 199 |
| Frontend tests | 63 | 89 |
| 合计 | 357 | **540** |

- 原测试全部保留；旧设置测试改为逐项接口的真实对象格式，语义场景不删除。新增共享契约双端运行、实际 Express/Hono HTTP、SSE 进度/中断、身份/失效/只读/冲突/403/429/超时、Cursor、预算、SQL 边界和 Proxy Body 回归。
- 本地真实 SQLite `statement.readonly` 核对只读语料；普通表与复合 WITHOUT ROWID 表分别完整遍历 10000 行，无重复/遗漏；100 页只需 103 次读取（首次结构 3 次，后续仅数据页），特殊名称与 Schema/credential 改变游标拒绝通过。不是远端 D1 验收。
- 三端类型检查、Lint 0 errors、backend/frontend/完整 Worker build、schema-check、ARM64 Docker 构建与隔离启动/旧库迁移/非 root/只读根/持久化/stdout/权限矩阵通过。存量 lint warning、大 chunk 提示保留。
- 原 DNS/套餐/浮层/缩放/reduced-motion、滚动、DNS 性能和 v2.7 浏览器场景保留通过；R2 虚拟列表回归先等首行，再滚动检查末行。v2.8 新四种视口/主题覆盖缓存页直接加载、页签共享、Dirty、单字段 PATCH、KV 增量、空 R2 页、特殊字符目录、预览 URL 释放与 D1 keyset。
- 无数据库迁移，7 张共享表列集合仍一致。没有修改真实生产记录、读取生产凭证或发布。

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
BUILDX_CONFIG=/private/tmp/cf-manager-buildx docker build -f docker/Dockerfile -t cf-manager:codex-v28 .
node scripts/test-docker.mjs cf-manager:codex-v28
node scripts/benchmark-v2.8.mjs
node scripts/benchmark-storage-v2.8.mjs
# 浏览器在所有构建完成后执行；FRONTEND_DIST 使用冻结副本。
FRONTEND_DIST=/private/tmp/cf-v28-final-dist PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-v2.8-ui.mjs
UI_REPORT=/path/to/v28-v27-regression.json PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-v2.7-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-plans-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-scroll-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-performance-ui.mjs
```

不要并行运行完整 Worker build 与复制 frontend/dist；Worker build 会重建 /admin 产物。旧 v2.7 报告保留，升级回归用现有 `UI_REPORT` 输出到新文件。macOS Chromium 需要沙箱外 Mach 端口，仅运行隔离临时浏览器，不操作用户已有浏览器。

## 残留边界与 v2.9

1. 未验证真实 CF 套餐/权限、D1 服务端 SQLite/PRAGMA、代理 TLS/网络、跨 isolate 命中或 Linux AMD64；需要部署后的只读采样。模拟不是生产可用性的全部证据。
2. 独立缓存是内存、TTL 和有限容量；外部更新可能暂时不可见，手动刷新与实时写前校验保留。Worker 冷启动不共享，Free invocation 子请求额度仍限制旧完整枚举。
3. 冲突检测、keyset 浏览都不是强事务/固定快照；外部并发写入、DDL 和无原子 CAS 的窗口仍存在。未知结果先检查实际资源，禁止自动重发。
4. 为控制浏览器/服务端体积，窗口/SQL/元数据/主键有上述上限；明确拒绝超限而非假装完整。大表复杂排序、BLOB/REAL 复合主键和超过 1000 表的管理需显式过滤 SQL。
5. 2027-03-31 前应基于只读部署采样评估默认逐项读取；SWR、能力 TTL、旧接口兼容都应以真实 403/429/延迟分位数调整。
6. v2.9 可优先采样：当前账号/页签切换、CF 连接与解析、慢代理；改进 R2/元数据超大列表的可回退窗口/服务端筛选；在独立安全设计下扩展 SQLite 语法解析与大结果导出，不为性能引入 Redis 或重写文件传输。

## 回滚

前端、Express/Worker 及共享适配一起恢复到 v2.7 基线对应发布包；保留 SQLite/D1、credentials、Account 主键、_migrations 与 ENCRYPTION_KEY，不删除业务数据。内存缓存随重启丢弃，无缓存迁移。没有新增依赖或表，回滚无需降级数据格式；新保存的本地 Account 名称已经去掉词组，仍为兼容字符串。回滚会恢复旧 D1 写控制和旧分页/缓存局限，需同步回滚调用方，不把它当安全改进。

## 修改文件清单

以下为当前相对 HEAD 的代码、配置、文档与测试；同步生成的副本、构建产物、临时截图和本地 PROJECT_MEMORY 不入提交。


### shared/

- `shared/accountDiscovery.ts`
- `shared/zoneDirectory.ts`
- `shared/zoneSettings.ts`
- `shared/accountName.ts`
- `shared/d1Resources.ts`
- `shared/d1SqlPolicy.ts`
- `shared/resourceCache.ts`
- `shared/storageResources.ts`
- `shared/tests/d1Resources.contract.ts`
- `shared/tests/storageResources.contract.ts`
- `shared/tests/storageRoutes.contract.ts`
- `shared/tests/zoneSettings.contract.ts`
- `shared/zoneSettingsEvents.ts`

### backend/

- `backend/src/models/account.ts`
- `backend/src/routes/dns.ts`
- `backend/src/routes/storage.ts`
- `backend/src/services/accountRouter.ts`
- `backend/src/services/performanceMetrics.ts`
- `backend/src/services/storageService.ts`
- `backend/src/services/zoneService.ts`
- `backend/tests/dnsRoutes.test.ts`
- `backend/tests/zoneSettings.test.ts`
- `backend/src/services/storageRuntime.ts`
- `backend/src/services/zoneSettingsRuntime.ts`
- `backend/tests/cfResponseLimit.test.ts`
- `backend/tests/d1Resources.test.ts`
- `backend/tests/storageResources.test.ts`
- `backend/tests/storageRoutes.test.ts`
- `backend/tests/zoneSettingsV28.test.ts`

### worker/

- `worker/src/db/models.ts`
- `worker/src/routes/accounts.ts`
- `worker/src/routes/dns.ts`
- `worker/src/routes/settings.ts`
- `worker/src/routes/storage.ts`
- `worker/src/services/credentials.ts`
- `worker/src/__tests__/d1Resources.test.ts`
- `worker/src/__tests__/storageResources.test.ts`
- `worker/src/__tests__/storageRoutes.test.ts`
- `worker/src/__tests__/zoneSettingsV28.test.ts`
- `worker/src/services/storageRuntime.ts`
- `worker/src/services/zoneSettingsRuntime.ts`

### frontend/

- `frontend/src/api/dns.ts`
- `frontend/src/api/storage.ts`
- `frontend/src/i18n/locales/en.json`
- `frontend/src/i18n/locales/zh-CN.json`
- `frontend/src/stores/dnsStore.ts`
- `frontend/src/utils/dnsAccountLabel.ts`
- `frontend/src/views/DnsView.vue`
- `frontend/src/views/StorageView.vue`
- `frontend/tests/dnsState.test.ts`
- `frontend/tests/dnsStore.test.ts`
- `frontend/src/components/ZoneSettingsFeedback.vue`
- `frontend/src/utils/storageReads.ts`
- `frontend/src/utils/zoneSettingsState.ts`
- `frontend/tests/accountName.test.ts`
- `frontend/tests/storageReads.test.ts`
- `frontend/tests/zoneSettingsState.test.ts`
- `frontend/tests/zoneSettingsStream.test.ts`

### scripts/

- `scripts/sync-shared.js`
- `scripts/test-scroll-ui.mjs`
- `scripts/benchmark-storage-v2.8.mjs`
- `scripts/benchmark-v2.8.mjs`
- `scripts/test-v2.8-ui.mjs`

### docs/

- `docs/performance-v2.8-baseline.json`
- `docs/performance-v2.8-storage.json`
- `docs/performance-v2.8-ui.json`
- `docs/performance-v2.8-v27-regression.json`
- `docs/performance-v2.8.md`

### 根配置/打包

- `.gitignore`
- `CHANGELOG.md`
- `docker/Dockerfile`

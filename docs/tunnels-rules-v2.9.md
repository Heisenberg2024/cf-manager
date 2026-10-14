# v2.9 Tunnels / Rules 审计与验收

## 审计基线

基线：`7a317de40bb05ea93834ed1ecc75e039e1c8da3e`，v2.8.2；工作区初始干净。2026-10-14 执行三端测试：backend 294、worker 241、frontend 98，共 633 项通过。

- `TunnelsView.openConfig` 的 Promise.all 将 Zone 失败与配置失败合并，catch 生成默认 404；saveConfig 只提交重建的 ingress，未知 hostname 也可能丢失。
- 双端 tunnelService 只返回 ingress，PUT 整体替换 config 时丢弃 originRequest、各条高级字段；没有保存基线、冲突检测或读回。
- 双端 wizard 在 Tunnel 创建后才检查 Zone，Zone/CNAME 冲突提前 return 绕过 catch；reuse 只保留其他 hostname 并替换 catch-all，没有保留完整快照。
- Tunnel hostnames 顺序扫描所有 Zone 的 CNAME，部分失败被吞掉。列表/连接没有有效缓存，页面初始化额外全账号读取 Zone。
- Rules 每次枚举 Rulesets 后 GET detail，只匹配 phase 未匹配 kind；SDK 默认重试写操作；新增/更新缺少 Demo 防护。前端浅合并复杂参数仍会改写未编辑字段。

## 官方协议参考

- [Tunnel configuration GET/PUT](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/)：config 包括 ingress 与 originRequest；PUT 按完整配置处理，不作为原子 CAS。
- [Ruleset scope/kind](https://developers.cloudflare.com/ruleset-engine/basic-operations/view-rulesets/)：Account entrypoint 为 root，Zone entrypoint 为 zone，managed/custom 不能误选。
- [Single Redirect API](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/)：http_request_dynamic_redirect 使用 Zone；保留已有 http_request_redirect 的 Account 范围。

## 实现与修改文件

| 模块 | 实现 |
|---|---|
| `shared/tunnelConfig.ts` | 完整 JSON snapshot、稳定比较、字段最小编辑、Catch-all 验证。明确返回的空 ingress 可读，写入仍须完整有效规则；缺失/null/非法配置禁止保存。 |
| `shared/tunnelResources.ts` | 列表和 Connections Fresh 30 秒、有界 200 份快照/8 MiB、Singleflight；配置安全 GET 每次上游重读且经原调度器限流/取消，不缓存配置或 Token。PUT 基线/版本检查，明确失败与未知分离，读回只在一致时确认成功。 |
| `shared/rulesResources.ts` | Ruleset catalog 按真实 scope/认证指纹共用，查询当前 Phase 时同时匹配 kind；详情键含 Phase/Ruleset ID。cursor 分页、重复游标/ID 拒绝，300 份快照/8 MiB/30 秒；读操作不创建 Ruleset，写后按真实 Account/Zone 范围及别名失效。 |
| 双端 `services/tunnelService.ts` / `rulesetService.ts` | 薄适配器复用共享流程。改用已有 `accountRequest` 的 REST 写入，并显式 `retry:false`，不经过 SDK 的默认写重试；Global Key/Token/代理/解密方式保持。Worker 按 DB 的 WeakMap 隔离 isolate 内实例。 |
| 双端 `routes/tunnels.ts` / DNS rules 路由 | Demo 全部修改入口防护、独立 Account rules 路径、完整配置和基线契约、结果分类与安全审计；原 DNS 精确归属解析保留。 |
| `TunnelsView.vue` / `api/tunnels.ts` / `utils/tunnelDraft.ts` | 当前账号优先，Rules 页签按需；配置与 Zone 独立失败/重试，完整 hostname/service 原样显示，原字段保留、顺序按钮、Diff、Dirty/取消/离页保护。复杂规则使用完整 JSON 编辑；错误保留草稿，局部读取实际规则，未知结果阻止直接重提。关闭/切换/卸载隔离迟到响应，Token 退出清除。 |
| `sync-shared.js` / Dockerfile / .gitignore | 唯一共享源同步，生成副本不提交；镜像同步复制。无新运行依赖、数据库迁移或密文变化。 |

向导先核实 Account 可用性、凭证可解密、Zone 实时归属、模式/hostname/port/protocol/path 类型、DNS 冲突及复用 Tunnel 的远程配置模式。创建模式先查同名 Tunnel；复用模式只新增缺失的 hostname+path，保留其他规则、完整高级配置和原 Catch-all。执行前重查 DNS 与归属。写权限、套餐和 CF 正则语义的最终支持仍由真实 CF 写响应决定，没有伪造“权限预检查通过”。

执行只记录本次确认返回 ID 的 Tunnel/CNAME。明确写拒绝进入统一补偿，先重核新 CNAME 身份再删除并确认；删除失败时保留依赖 Tunnel。复用 Tunnel 从不作为自动删除目标；已知配置拒绝无需还原未成功提交的旧配置。写超时、ID 缺失或确认失败返回 `unknown`，不重发、不删除可能已使用的资源；复用原完整快照和待核实配置包含在回执中。前端显示失败步骤与残留 ID。

## API 及兼容性

内部 `/api` 包装继续使用 `{success,data}` / `{success:false,error}`。`data.status` 表示远端执行结果；HTTP 200 或外层 `success:true` 不等于远端完成。

- Tunnel 配置 GET：`{config,version?,source?,fetchedAt}`；PUT：`{config,baseline:<GET snapshot>}`，返回 `{status,snapshot?,message?,recovered?}`。缺 baseline/旧 ingress-only 请求 fail closed；409 冲突不发 PUT。前后端应一起升级。
- Connections GET：`{value,cache}`，`refresh=true` 强制重读，UI 显示读取时间；Token 只在主动请求时读，不放入持久存储。
- Hostnames GET：默认仅配置 hostname 快速数据；`verify=true` 对已配置 hostname 查当前 Account 下真实 DNS，返回 `{hostnames:[{hostname,dns,error?}],complete,scope:'configured-hostnames',fetchedAt}`。这不是扫描所有 DNS 的完整关联域名清单，DNS 独有记录不会被误报为已检查。
- Rules GET 保留数组；Account `http_request_redirect` 使用 `/api/tunnels/accounts/:id/rules/:phase`，不依赖 Zone；Zone phases 继续 DNS 精确 `accountId+zoneId` 路径。
- Rule update/delete 带完整 `baseline`；写回执为 `{status,rule?,rules?,message?}`。更新保持原 enabled/ref/logging/ratelimit 与高级参数；不能安全发送的未知顶层规则字段阻止更新。
- Bulk Redirect 的 Account `http_request_redirect` 使用 `from_list`（已有 redirect list）；Zone Single Redirect 使用 `http_request_dynamic_redirect` + `from_value`，参见 [官方 Bulk Redirect API](https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/create-api/)。原复杂规则读取/编辑不转换 Action。

配置比较是 GET → 比较 → PUT → GET 的尽力保护，不是 Cloudflare 原子 CAS。向导锁只对同一进程/isolate 生效；不同进程/isolate 的竞态由再次读取、CF 冲突响应和未知回执收敛，不能承诺跨 CF API 的数据库事务。

## 性能对比（全部为合成值）

`performance-v2.9.json` 使用旧提交 verbatim Tunnel/Rules 服务与当前共享运行时，每 Account 5 个 Tunnel、两个 Rules Phase，固定模拟 1 ms 上游延迟；慢账号为 8 ms，每第七账号模拟 403。一般场景 10 次采样，hostname 场景 3 次；P95 是此有限样本的顺序统计值，不是生产 P95。

| 合成场景 | CF 请求数（旧→新） | P50 ms | P95 ms |
|---|---:|---:|---:|
| 20 Accounts 当前账号 | 41 → 1 | 10.84 → 1.24 | 13.46 → 1.73 |
| 60 Accounts 当前账号 | 121 → 1 | 26.21 → 1.21 | 27.78 → 1.44 |
| 1000 Zone / 100 Ingress 快速展示 | 1020 → 1 | 1199.55 → 2.35 | 1241.10 → 2.42 |
| 10 并发冷 Tunnel 请求 | 10 → 1 | 1.36 → 1.96 | 1.43 → 2.81 |
| 10 次重复 Rules 读取 | 20 → 2 | 23.59 → 3.01 | 25.14 → 5.96 |
| 10 次交替 Phase 读取 | 20 → 3 | 24.21 → 4.30 | 25.92 → 4.40 |

1020→1 比较的是旧全 Zone DNS 发现与新“配置 hostname 快速展示”，语义已明确区分；显式 DNS 验证不使用该单次请求结论。旧界面初始化扫描全部账号，当前账号路径减少与页面首次使用无关的请求。主动全账号 Tunnel 读取保持相同次数，并受全局 6/每绑定 2 调度限制：60 个慢/失败混合账号 P50 从 9.27 ms 到 31.17 ms，不能宣传全账号吞吐提升。

浏览器同夹具 1440/390 px × light/dark 各一次，20 Accounts，每 Account 100 Zone；旧初始内部 API 5 / 模拟 CF 41，新为 4 / 1。四组首屏可见耗时与同阶段 heap 为：

| 视口/主题 | 首屏 ms（旧→新） | 初始 heap MiB（旧→新） |
|---|---:|---:|
| 1440 / light | 221.5 → 303.2 | 10.42 → 10.38 |
| 1440 / dark | 211.6 → 222.0 | 10.48 → 10.40 |
| 390 / light | 208.4 → 204.5 | 10.21 → 9.93 |
| 390 / dark | 198.3 → 210.5 | 10.31 → 10.04 |

首屏可见耗时包含 Chromium/解析/布局，并未稳定改善；旧全 Zone 请求在 Tunnel 表格可见后执行，四次样本不能推导生产 P50/P95。内存是 Chromium used heap 的单次取样，未强制 GC，不作为容量承诺。`performance-v2.9-ui*.json` 保存原始结果；服务端缓存估算预算与进程 heap 分开报告。

复用 ReadScheduler 与 performanceMetrics/API logger：上游调用/403/429/5xx/网络/超时、缓存 lookup/hit/loaded/failed、read_merged、队列等待和读取耗时。无请求正文、Token 或配置内容进入新增审计；配置保存/向导/规则审计包含目标、动作和结果分类。

## 实际验证

- 三端测试 **764 项通过**：backend 356 / worker 303 / frontend 105；原 633 项保留，新增 131 项。覆盖完整 round-trip、originRequest、特殊 service/path、Catch-all、空与缺失配置、冲突、超时读回、创建/复用补偿、删除失败残留、重复执行、相同 CF Account 不同 Credential、Demo、cursor/kind/phase/scope、缓存/取消、Global Key 实际双端 HTTP 封装。
- 三端 `typecheck` / `lint`：0 errors。保留存量 any/Vue 样式 warnings；frontend 大 chunk 与 backend node-cron 缺 sourcemap 警告保留。
- backend/frontend 构建、完整 Worker 构建及 ZIP、DB schema check 通过，版本生成均为 2.9.0。
- `test-tunnels-rules-ui.mjs`：四组桌面/移动/深浅主题通过，验证 Zone 拒绝不覆盖配置、配置失败无默认规则/禁保存、Dirty/Diff/完整字段、冲突无第二 PUT、关闭后迟到响应、复杂规则字段、规则失败保留数据/重试、Account Phase 不读 Zone、Bulk Redirect 保留自定义表达式、无横向页面溢出及无 pageerror。
- `test-dns-ui.mjs`：原 DNS/跨 Zone/浮层定位/滚动回归通过。`test-v2.7-ui.mjs`：DNS 100/1000/10000 条桌面/移动、20/60 Account Workers、Drawer 按需与 Pages 原流程通过；`test-v2.8-ui.mjs`：Zone/KV/R2/D1 四组通过。原 v2.7 夹具缺少 v2.8.2 已要求的 Pages 分页 metadata，先定位后只修正夹具，未改变稳定模块；v2.8 脚本增加 UI_REPORT，保留历史 JSON。新结果为 `regression-v2.9-workers-ui.json` / `regression-v2.9-storage-ui.json`。
- **Linux ARM64** 镜像构建和完整隔离启动矩阵通过：非 root、read_only/cap_drop/权限边界、旧库迁移、持久化、root 降权、自定义 DB/log 路径、stdout-only、bind mount、不可写目录。**Linux AMD64** 镜像构建和同矩阵通过，运行于本机 Colima ARM64 的仿真环境，不等同原生 AMD64 服务器验收。
- 未使用生产凭证、修改远端 CF、提交、推送或生产部署；真实 Cloudflare/D1/生产代理及套餐权限未验收。

复验命令（Playwright 只安装于临时目录，未新增项目依赖）：

```sh
node scripts/sync-shared.js
npm --prefix backend test
npm --prefix worker test
npm --prefix frontend test
npm --prefix backend run typecheck
npm --prefix worker run typecheck
npm --prefix frontend run typecheck
npm --prefix backend run lint
npm --prefix worker run lint
npm --prefix frontend run lint
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix worker run build
node scripts/check-db-schema.mjs
node scripts/benchmark-tunnels-rules.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-tunnels-rules-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/benchmark-tunnels-ui.mjs
UI_REPORT=/path/to/new-report.json PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-v2.7-ui.mjs
UI_REPORT=/path/to/new-report.json PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-v2.8-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-ui.mjs
docker build --platform linux/arm64 -f docker/Dockerfile -t cf-manager:codex-tunnels-v29 .
node scripts/test-docker.mjs cf-manager:codex-tunnels-v29
docker build --platform linux/amd64 -f docker/Dockerfile -t cf-manager:codex-tunnels-v29-amd64 .
node scripts/test-docker.mjs cf-manager:codex-tunnels-v29-amd64
```

完整 Worker build 会重建 frontend/dist 为 /admin 版本。浏览器测试等待构建完成后冻结 dist，不能并行清理构建产物。首次 macOS 沙箱拒绝 Chromium Mach bootstrap，使用仅访问本地夹具的受准许隔离进程完成验收。

## 部署、回滚及剩余边界

1. 经用户明确批准后再部署：保留原 API_SECRET、ENCRYPTION_KEY、Credential/Account、代理和数据卷；先备份现有 SQLite 数据卷/D1 与版本产物。没有新迁移，已有 D1 版本流程保持。
2. 前后端整体升级为同一 2.9.0；验证 health，再用真实 Token/Global Key 做只读 Tunnel/config/Rules 与归属/权限检查。远端修改验收应单独选择可控测试资源并另行授权。
3. 需要回滚时停止应用写入，整体切回已备份 v2.8.2 产物及原配置；无本轮 schema 演进，数据卷原样保留。程序回滚不会撤销已执行 CF 写入，按确认快照/回执人工核对；禁止自动用旧完整快照覆盖当前变化。
4. 跨 isolate 同时写与 CF 最终传播仍可能出现竞态；unknown 回执不能解释为失败/零资源，应检查 Tunnel 名称/ID、CNAME/配置与 Rules 实际状态后再操作。补偿删除失败可能保留资源，UI 明确列出。
5. 结构不支持无损编辑的配置为只读；未知配置 JSON 字段按原值发送，真实 CF 是否接受并保留这些字段尚未远端验收，回读不一致明确报告 partial；未知顶层规则字段要求在 Cloudflare 编辑。Worker 外部子请求额度和 isolate 缓存寿命仍受原平台限制，不能把缓存当作持久事务记录。

## v2.10 后续规划

- 在另行授权的测试 Account 上验收真实 Token/Global Key、权限拒绝、CF 配置传播和 D1 部署；采集真实只读 P50/P95/429。
- 根据实际频率决定是否需要持久化操作回执/跨 isolate 防重放；若需要 schema 演进，单独设计迁移和保留期限，不能宣称当前内存锁有此能力。
- 补充复杂规则 JSON 的语义 Diff、按规则 Action 的 schema 引导；先保证字段无损，保持未知字段只读边界。
- 若真实日志证明瓶颈，再考虑更精确的 hostname/Zone 目录索引、GET capability cache 与 JS chunk 拆分，不提高无证据的写并发。


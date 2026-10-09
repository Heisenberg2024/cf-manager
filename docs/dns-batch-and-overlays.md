# 多 Zone DNS、套餐、浮层与列表滚动（2.5.3）

## 账户身份与域名套餐（2.5.3）

DNS 筛选、添加弹窗和域名分组统一展示凭证名称/本地凭证编号、账户名称与真实 Account ID；选择值和分组仍使用本地账户绑定 ID，同一 CF Account 经不同凭证绑定也不会混用。列表与详情直接展示 Cloudflare Zone `plan`，缺失时显示待确认。

`GET /api/dns/accounts/:accountId/plans` 读取选定账户已有 Zone 的可用套餐；无现有 Zone 时提供 Free/Pro/Business/Enterprise 候选，首次创建后验证。`POST /api/dns/domains` 支持可选 `plan`（默认 `free`），按规范化/去重后的输入顺序创建并分配。`shared/zonePlans.ts` 同步双端：用 available_plans 的公开 `legacy_id` 订阅，不能把其不透明 `id` 作为 rate_plan ID；写后 GET Zone 确认实际套餐。

只有新 Zone 的套餐明确不可订阅，或订阅返回明确容量拒绝，才把该项及余下域名保留为 Free。权限、限流、网络或实际套餐未生效不会报告为名额不足；流程停止后续域名，返回已创建 Zone/NS、实际套餐或待确认状态、错误与 `fallback_count`。创建回执不会因列表刷新失败丢失。公开 API 没有可靠剩余 Enterprise 名额，不推算或承诺数量；真实合约容量以 Cloudflare 返回为准。套餐读取/写入分别需要 Billing Read/Write，Free 创建不依赖 Billing 权限。[可用套餐](https://developers.cloudflare.com/api/resources/zones/subresources/plans/methods/list/)、[套餐订阅](https://developers.cloudflare.com/api/resources/zones/subresources/subscriptions/methods/create/)

`shared/tests/zonePlans.contract.ts` 覆盖 5 域名/3 Enterprise 名额、显式容量拒绝、失败域名不消耗名额、读写权限、未知结果、未实际生效、空账户与归属错误；两端还有 HTTP 路由测试。隔离 UI 脚本检查同名凭证/账户、套餐标签、账户切换迟到响应、Billing 权限失败与 Free 选择、桌面/390px 窄屏：

```sh
# 可使用临时产物，不覆盖 frontend/dist
cd frontend && node node_modules/vite/bin/vite.js build --outDir /private/tmp/cf-manager-dns-plans-dist
cd ..
FRONTEND_DIST=/private/tmp/cf-manager-dns-plans-dist PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-plans-ui.mjs
```

## 定位审计与根因

前端锁定 Vue 3.5.37、Naive UI 2.44.1；浮层由 Naive UI 的 vueuc Binder/Follower 定位，不使用业务自建 Popper/Floating UI。Follower 默认 Teleport 到 body，计算触发元素与容器 rect，并以内联 `transform: translateX(...) translateY(...)` 定位；库默认监听 resize、scroll 并使用 vdirs 管理层级。

App 的 Config/Dialog/Message 等 Provider 与 root/layout 均正常；没有业务自定义 `to`/portal target。body 没有 transform，触发 rect 也不是 0。可复现回归来自 `style.css` 的 reduced-motion 通配规则 `transform: none !important`。触发按钮 x=1306，Follower 内联仍计算 translateX(1323px)，但实际 computed transform 为 none，菜单落在 x=0/y=6；no-preference 下菜单 x≈1284/y=47。

修复仅移除全局 transform 重置，保留动画、过渡缩短与无障碍偏好；不覆盖库的 positioning、Teleport 或 z-index，不使用任何菜单 top/left/translate 硬编码。新增表单提示中的 `@` 与存量规则提示中的 `${...}` 使用 Vue I18n literal interpolation，避免渲染异常；所有中英文消息有编译回归测试。

## 长列表滚动修复（2.5.2）

DNS 的旧 `.n-card__content` 选择器未命中 Naive UI 2.44 实际内容节点，100 个 Zone 的内容超过 7000px，被有限高度卡片裁掉，滚轮无法滚动。卡片改用公开 `content-class`；工具栏不收缩，独立 `.dns-zone-list` 使用 `flex: 1; min-height: 0; overflow-y: auto`，NSpin 保持自然内容高度。列表支持键盘 PageDown，搜索、刷新及跨账户选择沿用现有行为。

Naive Grid 的 `m` 断点为 1024px；断点以下 DNS、KV/D1/R2 上下排列，不能继续使用单行 Grid 的 `100%` 高度。列表卡片和详情卡片分别用有上下界的视口高度，列表与详情表格各自滚动，外层页面负责在面板之间滚动。存储页桌面 KV/R2 原有内联滚动样式仍有效，同时移除过时 Card 类名依赖。商店 Drawer 通过 `body-content-style` 建立高度链，README 独立滚动，操作栏保留在视口内。

`scripts/test-scroll-ui.mjs` 使用冻结构建、合成数据和真实滚轮/键盘操作，覆盖 1440×900、1100×650、900×700、390×844：100 Zone 分组/单账户列表、搜索/刷新/选择保留、DNS/KV/R2 详情表格、100 项 KV/D1/R2 列表、60 个商店模板和 150 段 README；另检查桌面的 AI 统计、设置、Workers 和 Tunnel。测试等待 NSpin 退场，避免加载遮罩截获滚轮造成误判。

## 操作入口与流程

DNS 左侧保留跨搜索、跨账户筛选的复合身份选择。`选择全部搜索结果` 明确选择当前账户/搜索过滤后的全部结果；Zone 列表没有隐藏分页。`批量 DNS` 提供新增、修改、删除、Proxy、TTL；`更多 → 删除域名配置（Zone）` 仍是独立的 Zone 删除流程。

统一流程：配置 → Preview → 核对变更/目标数量 → 勾选明确确认 → Execute → 进度与结果。匹配使用相对 Host + Type，可附加严格 Current Content。`@` 对应各 Zone apex，`www` 对应 `www.<zone>`。

单/多 Zone 共用 `DnsRecordFields.vue` 与 `shared/dnsRecord.ts`：A/AAAA/CNAME/TXT/MX/CAA/SRV/NS/PTR；MX priority、SRV priority/weight/port/target、CAA flags/tag/value 均有定义。修改只发送勾选字段，SRV/CAA data 会合并未修改部分。Proxy 只发送 proxied，TTL 只发送 ttl。Cloudflare 的 proxied DNS 使用 Auto TTL，这是上游规则；不能对已代理记录写入非 Auto TTL。

## 双端执行与安全

- `POST /api/dns/batch/preview`：1–500 Zones，返回最多 5000 条记录的预览。每个 Zone 使用 credentialId、本地 accountId、zoneId、zoneName；从数据库重新解析 Account/Credential，并 GET CF Zone 验证真实 Account/Zone 归属。Demo、禁用账户、缺少 DNS 功能或改变绑定不会写入。
- Create 默认同 Type/Name/Content 为 SKIP，不同 Content 为 CONFLICT；CNAME/NS 类型冲突也拒绝。明确策略可更新唯一记录或允许额外创建；多个同类型记录禁止模糊覆盖。
- Update/Delete/Proxy/TTL 精确匹配 Name/Type。未找到为 NOT_FOUND，严格 Current Content 不符为 CONFLICT；任何单项错误不停止其他 Zone。
- 预览使用 ENCRYPTION_KEY 派生 HMAC，15 分钟有效；Execute 拒绝修改过或过期的预览。SQLite/D1 `dns_batch_executions` 原子消费 UUID 防重放，仅保存 ID/过期时间，不保存 DNS 内容或凭证。
- `POST /api/dns/batch/execute`：一次 POST + SSE，浏览器不按 Zone 循环发请求。并发 3 个 Zone，Zone 内记录依次执行。每次 PATCH/DELETE 前重读完整记录快照；Create 重读同名记录集合，变化时要求重新预览。
- 共用 `createCfRequest`：只对明确 429 重试，最多两次，优先 Retry-After，否则 500ms/1000ms backoff；超过 5 秒的等待指示返回真实限流错误而不提前重试。模糊网络写入失败不自动重试。
- SSE 支持 PENDING/RUNNING/SUCCESS/SKIPPED/CONFLICT/NOT_FOUND/FAILED；结果可按成功/失败/跳过/冲突/未找到过滤，携带 Zone/记录/动作/HTTP status/CF code/message。发生断流时显示结果未确认，刷新并重新预览，不能重发已消费预览。
- 日志/审计只保存身份、动作、结果和错误码，不无条件记录 TXT Content。认证信息沿用现有脱敏流程。
- 完成或断流后刷新受影响的当前 Zone；其他 Zone 没有记录缓存，下次打开直接请求 CF。记录/设置请求身份与 Preview generation 防止旧请求覆盖新状态。

## 升级、构建与限制

Docker/SQLite 启动自动创建收据表；D1 先运行 `node worker/scripts/migrate.mjs` 应用 `0012_dns_batch_executions.sql`，再发布新代码。保留已有 ENCRYPTION_KEY、Account 主键与数据卷。

共享源码通过 `scripts/sync-shared.js` 同步两端与 `frontend/src/shared`；后者为忽略产物。前端 predev/prebuild/pretypecheck/pretest 的 `--frontend` 模式只复制文件，不依赖 backend 的 AJV。Docker 的扁平前端 builder 直接复制 shared 源码并跳过 pre/post hook；CI 前端使用 npm run build。

Cloudflare Worker Free 每次调用仅允许 50 个外部 subrequests，Paid 默认 10000；大规模任务受部署套餐及 CF API 限流约束。Docker 无 Worker invocation 限制。[Cloudflare 官方限制](https://developers.cloudflare.com/workers/platform/limits/#subrequests)

当前没有生产 CF/D1 在线验收；不把模拟 CF、Node 中运行的 Hono/D1 mock、静态检查或本机 ARM64 镜像构建视为生产权限、D1 服务或 Linux AMD64 验收。

## 可重复验收

三端现有 lint/typecheck/test/build；schema：`node scripts/check-db-schema.mjs`。

`shared/tests/dnsBatch.contract.ts` 由两端各自的 Vitest 注入测试工具，避免跨项目 node_modules 依赖。覆盖案例 A–E、500 Zone/并发 3、apex、全部支持类型、重复策略、快照变化、归属错误、部分 403/429/502、严格删除和复杂字段。各端独立 HTTP/SSE 测试覆盖签名/防重放/TXT 审计脱敏。前端测试包含流分块/断流、全部语言消息编译、跨 Account/Zone 的旧请求与刷新。

浏览器验收脚本读取生产构建，使用合成 API/CF 数据，不读取真实凭证：

```sh
npm run build --prefix backend
npm run build --prefix frontend
# 使用已安装的 Playwright，或将 PLAYWRIGHT_MODULE 指向已有运行时中的包路径
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-dns-ui.mjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-scroll-ui.mjs
```

脚本使用隔离临时 Chromium profile 的原生 100%/125%/150% 默认缩放并校验 devicePixelRatio，覆盖 reduce/no-preference、DNS Account Select、普通/多选 Dialog Select、批量菜单、Account/表格 Dropdown、Header、Raw/普通 Popover、Tooltip、Popconfirm、Date Picker、Drawer Select、resize 与真实内部滚动。右键菜单、Autocomplete、command menu 在项目中不存在。移动端检查 390px Batch Dialog。

浏览器日志、截图默认写入 `/private/tmp/cf-manager-dns-ui`；应用中无调试位置 CSS/console。具体最终检查结果见 PROJECT_MEMORY.md。

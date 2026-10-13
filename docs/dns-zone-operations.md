# DNS 批量 SSL/TLS、缓存清除与账户标签（2.8.1）

## 使用

在 DNS 管理的域名列表勾选目标，或按账户/多行搜索筛选后点击“选择全部搜索结果”，从“批量 DNS”菜单进入：

- **批量修改 SSL/TLS**：SSL 模式、始终使用 HTTPS、自动 HTTPS 重写、安全级别均默认“保持不变”，只提交明确选择的字段。
- **批量清除缓存**：清除列表中每个实际 Zone 的全部 Cloudflare 缓存；不改 DNS 记录或本地设置草稿。

确认目标及操作后勾选确认框，再执行。准备及结果阶段只能手动关闭；执行期间禁止关闭或重复提交。长结果列表独立滚动，390px 移动视口保留操作栏。

## 执行与结果

- `ZoneBatchSettingsDialog.vue` 捕获本地 Account ID、真实 Zone ID、域名和账户标签；`zoneOperations.ts` 按实际 Zone 去重，包括通过其他凭证重复绑定的 Zone，保留跳过行。
- 使用既有双端 `/dns/domains/:domain/settings` 和 `/purge-cache`，每次请求携带精确 `accountId` / `zoneId`，由服务端实时核实归属和演示保护。跨域名并发最多 3，不依赖全账户归属猜测。
- SSL 预览主动刷新当前设置。每行仅提交所选字段和该行读取的基线；复用既有 GET / 权限 / 基线检查 → PATCH → GET 确认流程。只读、冲突、部分成功、失败、未知均展示原始逐字段回执；一行失败不阻止其他域名。
- HTTP 403/409 等明确拒绝保留状态，展示为失败；5xx、断流或缺失确认展示结果未知。同批结果不能重新执行，不自动重发未知写入。
- 缓存清除发送唯一字段 `{ "purge_everything": true }`，需要非空回执 ID 才显示成功。成功表示 Cloudflare **接受请求**，不能据此断言某个 URL 已命中 MISS。参考 [Cloudflare 缓存清除接口](https://developers.cloudflare.com/api/resources/cache/methods/purge/)。
- SSL 批次完成后按 Zone 失效所有前端凭证别名的设置快照，丢弃旧读取并刷新当前设置。未保存草稿保留，远端修改可能产生冲突，需重新核实。缓存清除不失效设置快照。

## 账户下拉

DNS 筛选/添加域名、Storage、Tunnel、AI 四个页签、浏览器渲染、Workers 部署、商店部署及定时任务统一显示 **账户名称｜凭证名称**。

`useAccountLabels.ts` 复用 `dnsAccountLabel.ts`：按 `credential_id` 从 `/credentials` 获取凭证管理中的真实名称；仅规范化账户名称中的完整 `'s Account` 词组，凭证名称原样保留。读取失败使用凭证编号占位；不从账户名称猜测凭证。名称读取在组件作用域内，合并并发读取，卸载或认证身份改变后丢弃迟到结果。

双端 Tunnel 账户列表增加 `credential_id`。原下拉选择值、启用/功能筛选、AI 自动分配及按真实 Account 去重、R2 标签均保留；长选项换行，悬停显示完整标签。

## 验证与部署边界

已执行：

```sh
node scripts/sync-shared.js
(cd frontend && npm run typecheck && npm test && npm run lint)
(cd backend && npm run typecheck && npm run lint && npm test -- --run tests/zoneSettings.test.ts tests/zoneSettingsV28.test.ts tests/dnsRoutes.test.ts)
(cd worker && npm run typecheck && npm run lint && npm test -- --run src/__tests__/zoneSettingsV28.test.ts src/__tests__/dnsRoutes.test.ts)
```

前端 95、Backend 30、Worker 26 项相关测试通过；三端类型检查与 Lint 无错误，保留样式/any 警告。前端临时 Vite 构建通过，仍有大 chunk 提示。

离线 UI 回归命令（复用现有 Playwright 包，不新增生产依赖）：

```sh
cd frontend
node node_modules/vite/bin/vite.js build --outDir /private/tmp/cf-manager-dns281-dist
cd ..
FRONTEND_DIST=/private/tmp/cf-manager-dns281-dist PLAYWRIGHT_MODULE=/path/to/playwright \
  node scripts/test-dns-zone-settings-ui.mjs
```

1440px / 390px × 浅色 / 深色覆盖两种批量流程、默认不改字段、精确目标与基线、Zone 去重、失败/未知后继续、回执与结果不可重提、遮罩/Esc 不关闭、执行期间关闭禁用，以及 12 处账户选择器与视口边界。

以上为合成 API / 隔离浏览器验证。未使用真实 CF 凭证、部署或提交；真实 Zone 权限和 CDN 清除效果需在部署环境验收。没有新依赖或数据库迁移。

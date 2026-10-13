# CF Manager v2.8.2 Pages 分页热修复

日期：2026-10-14。未提交、推送或部署。

## 根因与请求变化

用户提供的真实 Cloudflare 测试：生产采用 Global API Key + Email；Workers Scripts 成功返回 21 条。Pages 不传分页大小或仅传 `page=1` 成功返回 10 条，`per_page=20/25/100` 均返回 HTTP 400 / Code 8000024。第一页 `result_info` 为 `{page:1,per_page:10,count:10,total_count:20,total_pages:2}`。

| 读取 | v2.8.1 | v2.8.2 |
| --- | --- | --- |
| Workers | `GET /accounts/<id>/workers/scripts` | 相同，SinglePage，不添加分页参数 |
| Pages 第一页 | `GET /accounts/<id>/pages/projects?page=1&per_page=100` | `GET /accounts/<id>/pages/projects?page=1` |
| Pages 第二页 | 生产中第一页即失败 | `GET /accounts/<id>/pages/projects?page=2` |
| 完整数量 | Pages 读取失败 | 21 Workers + 10 + 10 Pages = 41 |

Cloudflare [Projects List API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/) 将 `page` 和 `per_page` 定义为可选参数。读取不假设默认大小为 10，而是使用每次响应的真实元数据；模拟回归也验证默认每页 7 的情况。

## 修复边界

- 只修改共享读取器的 Pages 分页及普通负缓存刷新规则，双端通过原 `sync-shared.js` 同步；共享响应类型补充 `page` / `count`。
- 每页要求完整、安全整数的 `page/per_page/count/total_pages/total_count`；page 对应本次请求，count 与实际数组长度及该页应有数量一致，分页大小为正数，总页数与总数吻合且最多 1000 页。
- 各页总数、页数和分页大小保持一致；拒绝重复项目 ID/名称、短页、空缺中间页、异常结果/错误回执，结束时验证累计数量。零资源仅在元数据明确为零时成功，兼容 `total_pages=0/1`。
- 第二页失败时不返回第一页面的 10 个 Pages 为完整成功；Pages 数量保持 null/失败状态，已成功的 21 Workers 仍保留。普通错误负缓存保持 5 秒，显式 refresh 可绕过；429 冷却仍保持 5 分钟。
- 原列表/用量 TTL、Singleflight、调度、取消、generation、身份/凭证指纹、内存预算和失效路径保留。Global Key 认证、账号配置、数据库及依赖未修改。

## 修改文件

- `shared/workerResources.ts`：分页完整性与普通失败缓存的手动刷新。
- `shared/accountDiscovery.ts`：只补充 result_info 类型字段。
- `shared/tests/cloudflareWorkerResources.fixture.ts`：按真实请求路径返回两页数据或 Code 8000024；合成 Global Key + Email，无生产凭证。
- `shared/tests/workerResources.contract.ts`：双端完整读取、等待第二页、异常分页/重复项目、失败状态、缓存、刷新、零资源、账号/凭证隔离。
- `backend/tests/workersRoutes.test.ts` / `worker/src/__tests__/workersRoutes.test.ts`：两套 HTTP 路由的 41 资源、普通错误恢复、空账号回归及既有夹具修正。
- `backend/tests/workersPerformance.test.ts`：既有性能夹具使用完整分页元数据，不改性能逻辑。
- `frontend/tests/workerStore.test.ts`：保留已确认数量、部分失败不缓存为完整列表、显式刷新恢复、零资源。
- `scripts/test-pages-pagination-docker.mjs`：在禁网、只读容器中验证镜像实际编译产物与版本。
- `CHANGELOG.md`、本文；本地 `PROJECT_MEMORY.md` 已更新（仓库排除文件）。生成副本、version.ts 和构建产物不手工编辑、不纳入提交。

## 已执行验证

| 项目 | 结果 |
| --- | --- |
| Backend `npm test` | 294 项通过 |
| Worker `npm test` | 241 项通过 |
| Frontend `npm test` | 98 项通过 |
| 合计 | 633 项通过 |
| 三端 `npm run typecheck` | 全部通过 |
| 三端 `npm run lint` | 0 errors；现有代码风格/any 等 warnings 保留 |
| Backend / Frontend `npm run build` | 通过 |
| Worker `npm run build` | 完整前端、Worker 和 ZIP 通过，版本 v2.8.2 |
| `node scripts/check-db-schema.mjs` | 双端共享表结构一致 |
| Docker ARM64 镜像构建 | `cf-manager:codex-v2.8.2` 成功 |
| 镜像内 Pages 回归 | SinglePage、两页 20/合计 41、Code 8000024、错误缓存/强制刷新、重复第二页拒绝全部通过 |
| Docker 运行矩阵 | UID 1000、只读/无 capabilities、旧库迁移、独立绑定删除、重建持久化、root 降权、自定义 DB、stdout-only、bind mount、不可写目录失败全部通过 |
| `git diff --check` | 通过 |

复验命令（项目根目录）：

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
BUILDX_CONFIG=/private/tmp/cf-manager-buildx docker build -f docker/Dockerfile -t cf-manager:codex-v2.8.2 .
node scripts/test-pages-pagination-docker.mjs cf-manager:codex-v2.8.2
node scripts/test-docker.mjs cf-manager:codex-v2.8.2
git diff --check
```

## 剩余验收边界

- 新增测试复现用户提供的真实响应格式与拒绝参数，未访问真实 Cloudflare、生产账号、D1 或生产代理。实际 20 个项目的生产回读仍需在部署环境验收。
- 若读取期间项目变化导致总数/页数不一致，会保守报告失败，可手动刷新重新读取；不将跨页读取声明为固定快照。
- 默认页大小由上游决定，仍受既有 30 秒读取截止、1000 页和 Worker invocation 子请求限制。
- 验证平台为本地 Linux ARM64 Docker；Linux AMD64 未运行验收。前端大 chunk 与既有 Lint warnings 保留。

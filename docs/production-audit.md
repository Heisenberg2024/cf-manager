# 生产可用性审计与验收

审计基线：`5742b36` / 2.4.1。2026-10-05。下表记录初始问题，实施与验收状态见末尾清单；不代表真实 Cloudflare/D1 环境已验收。

| 模块 | 已有能力 | 已确认问题 / 改造方向 |
| --- | --- | --- |
| Account / Credential | Token / Global Key、加密、分页、批量、CSV、功能/计划探测 | accounts 保存密文；验证依赖 /user；发现只采用首账户；新增 credentials 并保留原 Account 主键，发现分页、手动验证、同步/独立绑定 |
| 数据库 | SQLite WAL/FK、版本迁移、D1 完整 schema | D1 迁移运行器把 constraint failed 当幂等成功且读版本失败静默继续；凭证迁移必须可恢复、可重复、无丢失 |
| DNS / Zone | 全量记录、单条 CRUD、Zone 批量创建/删除、规则、清缓存 | 同 Token Zone 跨账户重复归属；域名查找默取第一条；Worker DNS 单页；记录无多选批量；刷新命中 5 分钟缓存 |
| Cache / Zone Settings | SSL、安全、cache level、browser TTL、development mode 等 | 双端 GET 形状不同；0rtt 映射缺陷；错误读取变空对象并填默认值；minify 格式不正确；PATCH 失败仅字段名，缺少远端回读 |
| Workers / Pages | Account 路径、批量部署、回滚、重部署、资源配置 | Store 竞态；Drawer 身份改变复用数据；环境变量编辑把其他明文值改为空；绑定 debug 日志；部分跨账户列表无并发上限 |
| Storage | KV/D1/R2 CRUD、分页/查询、schema 管理 | KV 列表缓存不保证主动刷新/创建可见；请求竞态；KV key / R2 object 删除缺明确确认；R2 批量无限 Promise.all |
| Tunnel / Rules | Account 路径、向导回滚、规则 CRUD | 切换后旧请求覆盖；规则/Ingress 保存状态需回读；保留已有回滚和 demo 限制 |
| AI / Browser / Dashboard | Account ID 调度、配额主键按本地 Account、有限故障转移 | Workers/Settings 请求 pageSize=10000 仍被限制为 500 行；配额/模型/日志刷新竞态；继续保持明确 Account 上下文 |
| API / 错误 | 内部 wrapper、OpenAI 错误体、解密错误 | CF status 未统一映射；前端 CF 401/403 会清管理登录；网络/超时/权限混为无效凭证；集中错误和脱敏 |
| 日志 | stdout + 20 MB / 7 天轮转 | V1 打印认证头前缀、Cookie 和请求体；审计 detail 未脱敏；日志路径在镜像布局下成为 /data/logs |
| Docker | 多阶段构建、数据卷、healthcheck | entrypoint chown -R /app、non-root 仍 su-exec；需 build 权限 + 数据可写预检；DB health；root/non-root/read_only/cap_drop 验收 |
| UI | zh-CN/en、深浅主题、统一表格、局部 loading | 默认玻璃/光晕/动画造成噪声；保留框架和主题，简化背景、位移、复杂过渡 |

## 实施原则

1. 新增 credentials，accounts 继续代表独立 Cloudflare Account；原主键和关联不变。迁移转存现有密文，不重加密、不改 ENCRYPTION_KEY。
2. 发现、错误和设置规范化使用共享纯逻辑，运行时适配 Express / Workers；资源调用继续通过 Account 上下文定位凭证和 CF Account ID。
3. CRUD 捕获操作开始时身份；列表/表单通过请求身份和 loading 归属保护。用户刷新绕过缓存，写操作失效对应缓存。
4. 危险操作确认对象、数量、范围；批量有限并发、保留部分失败和进度结果。
5. 本地测试和模拟 API 不等于真实 Cloudflare/D1/浏览器验收，不使用真实资源执行破坏性测试。

## 本地验收结果

- [x] Credential / 账户发现 / 手动 fallback / Global Key / 独立绑定 / 同步 / 旧库迁移测试
- [x] DNS CRUD / 选择范围 / 批量部分成功失败 / 刷新 / 竞态测试
- [x] Settings GET→UI→PATCH→GET，远端实际值与错误/不可编辑字段测试
- [x] frontend lint / typecheck / build 和关键状态测试
- [x] backend lint / typecheck / test / build
- [x] worker lint / typecheck / test / bundle，schema check
- [x] Docker 默认 / non-root / read_only / cap_drop ALL / no-new-privileges / 不可写数据 / LOG_DIR / health
- [x] 最终 diff、敏感信息、未跟踪文件和项目记忆审核

实际执行：三端 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 全部通过；backend 72、worker 35、frontend 14，共 121 个测试。Worker 完整构建生成 2.5.0 Pages ZIP；三端 npm audit 均为 0。lint 有存量 any/模板样式警告，构建有大 chunk 提示，均未阻断验证。

`BUILDX_CONFIG=/private/tmp/cf-manager-buildx docker build --pull=false -f docker/Dockerfile -t cf-manager:codex-audit .` 成功。`node scripts/test-docker.mjs` 通过默认/non-root/root/read_only/cap_drop/no-new-privileges/init/tmpfs、host bind、旧库升级、独立绑定删除、重建持久化、不可写数据明确报错及 stdout-only 模式。测试容器与卷已清理，保留本地镜像供复验。

Headless Playwright + 本地模拟 API 验证了实际组件：Token 检测、多账户选择保存、当前页/全记录选择与单条勾选、批量 24 成功/1 失败并自动刷新、设置仅提交变更字段且 UI 最终值与远端响应一致，无页面异常。此为模拟界面验收，未使用真实凭证。

最终已检查完整累计 git status、工作区/暂存 diff、所有拟提交新增文件、三份锁文件变更；未执行 add/commit/push/deploy。PROJECT_MEMORY.md 已更新。

## 真实限制

- 尚未执行真实 Cloudflare 权限/套餐、生产网络和真实 D1 迁移验收。
- 历史重复凭证保留以避免自动合并身份，新导入已规范化复用。
- 原 KV/D1/R2 定时备份/清理尚未实现，现明确失败，不能用于生产备份或清理；配额报告保存实际本地数据。
- 部分存量 lint 警告和大 chunk 提示仍存在；主入口由约 1.10 MB 减至 0.76 MB。

# 凭证、多账户与升级

## 模型与操作

`credentials` 只保存一份加密 API Token 或 Global API Key；`accounts.credential_id` 关联凭证，`accounts.account_id` 指定真实 Cloudflare Account。所有资源继续使用本地 Account 主键，配额和审计归属不变。相同凭证的新建/导入通过 HMAC 指纹复用；不会在多个 Account 行中复制 Token。

添加时只需要 API Token，或 Email + Global API Key。点击“检测凭证 / 获取账户”：后端分页调用 `GET /accounts`，单账户自动选中，多账户默认全选，可取消部分账户。Account ID 默认不要求填写。

不能枚举账户时允许手工 Account ID：先验证 `GET /accounts/{id}`，受限 Token 可通过匹配 Zone 所属账户或目标账户的 Workers / KV 读取验证。只把明确的无效/过期 Token 判为无效；权限不足、网络、429 和超时分别显示。429 最多两次重试，较长 Retry-After 直接返回，避免提前重试。

“重新验证 / 同步”显示现有、不可访问和新发现账户，不会自动删除或自动添加本地绑定；用“关联新账户”选择添加。已确立的有效 Account ID 不可改到其他 Account；切换应新建绑定，以保留历史配额和审计归属。修改 Credential 会影响同 Credential 下所有账户；改 Account 名称、计划、功能、启用状态只影响该绑定。删除某个绑定保留凭证及其他绑定；删除整个 Credential 只删除本地绑定和关联配额，不删除 Cloudflare 资源。

管理页面不会读取或展示已存储的原始 Token。旧受保护的凭证获取 API 和用户显式选择的凭证 CSV 导出保持兼容；管理页面默认导出不含密钥，请只在受信环境保管包含凭证的导出。

## SQLite 自动升级

1. 停止旧实例，备份完整数据卷；保留原来的 `ENCRYPTION_KEY` 和 `API_SECRET`。不要删除数据库或更换加密密钥。
2. 2.5.0 启动时创建 `credentials`，为 `accounts` 添加 `credential_id`、`is_enabled`、`access_status`、`last_checked_at`。
3. 在事务中逐条转存原密文、建立关系，再清空 Account 行的 legacy Token/Key 列。不重加密、不改变 Account ID、Quota/Audit 外键。迁移可重复执行。
4. 首次使用“同步”确认各凭证实际访问状态。历史缺少 Account ID 的绑定需要手工补全，或从新发现账户添加后移除旧空绑定。

旧库中已有的重复凭证分别保留，避免未经确认合并身份和配额；新导入会复用能识别的匹配凭证。损坏/无法解密的旧密文仍保留供恢复。

## D1 升级

按现有部署流程执行 `node worker/scripts/migrate.mjs`，将 `0011_credentials.sql` 按序应用并记录。新建库使用 `worker/src/db/schema.sql`。迁移不会修改 Encryption Key。读取迁移历史失败、真正的约束冲突会中断部署，不再把约束失败误认为成功。

迁移中断后可再次执行：已创建的列跳过，回填语句幂等。部署时必须先迁移，再发布新版 Worker；不能只发布新代码。

## 回滚

优先恢复停机备份，再使用旧镜像/Worker。新版写入后若要保留新增账户回滚旧程序，需先停机并备份，再在数据库中将凭证字段回填旧列：

```sql
UPDATE accounts SET
  auth_type = (SELECT auth_type FROM credentials WHERE id = accounts.credential_id),
  api_token = (SELECT api_token FROM credentials WHERE id = accounts.credential_id),
  api_key = (SELECT api_key FROM credentials WHERE id = accounts.credential_id),
  email = (SELECT email FROM credentials WHERE id = accounts.credential_id)
WHERE credential_id IS NOT NULL;
```

不要在新版仍运行时执行回填；新版会继续以 Credential 为凭证事实来源。保留新表/列对旧程序无害，旧程序不支持凭证分组。回填会恢复旧模型的一 Account 一份密文，仅用于回滚。

## API 兼容与身份

- 原 `/api/accounts` CRUD 保留；添加响应额外包含 `credential_id` / `ids`，`id` 兼容单账户调用。
- 新增 `/api/credentials`、`/discover`、`/:id/sync`、`/:id/accounts`，以及凭证更新/删除。
- DNS/规则操作可传 `accountId`（本地主键）和 `zoneId`。有多个同名 Zone 绑定而未明确身份时返回 `409 AMBIGUOUS_ACCOUNT`，避免操作错账户。
- 设置 GET 保持以字段名为 key 的值对象，新增 `__meta` 标明可编辑性；PATCH 返回逐字段结果及 GET 确认的 `settings`。不同于提交值的远端结果会明确列入失败摘要。

## Docker 建议配置

镜像默认 UID/GID 1000，应用代码 `/app` 在镜像构建时安装，运行时不需要写入。只让数据卷和 `/tmp` 可写。升级前准备数据卷权限，保持原密钥：

```yaml
services:
  cf-manager:
    image: cf-manager:codex-audit
    ports:
      - "127.0.0.1:33000:3000"
    environment:
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      API_SECRET: ${API_SECRET}
      DB_PATH: /app/data/cf-manager.db
      LOG_DIR: /app/data/logs
      TZ: Asia/Singapore
    volumes:
      - ./data:/app/data
    user: "1000:1000"
    init: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=64m,noexec,nosuid,nodev
    pids_limit: 200
```

Linux bind mount 若初始权限不符，先停止服务并仅对数据目录准备 `1000:1000` 所有权；非 root entrypoint 不执行 chown 或 su-exec。显式 root 模式可针对数据/日志目录修正后降权，需要传统 root 的降权能力；加固部署应使用上面的非 root 模式。

stdout 始终保留；仓库 Compose 限制容器日志最多 3 个 10 MB；文件日志每类最多 7 个、每个 20 MB，避免仅按天保留造成高流量期间无限增长。`FILE_LOGGING=false` 可以只保留 stdout，且不要求 LOG_DIR 可写。`GET /api/health` 不需要认证，不调用 Cloudflare，仅检查本地数据库/初始化状态；失败为 503。

本地可复验：`node scripts/test-docker.mjs cf-manager:codex-audit`。脚本创建并清理隔离测试容器/数据卷，不调用真实 Cloudflare。镜像 `cf-manager:codex-audit` 是本次本地测试产物，尚未推送或部署。

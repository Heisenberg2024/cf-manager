# CF Manager 部署指南

CF Manager 支持三种部署方式。推荐使用 **Fork 一键部署**，最简单无需任何工具。

| 方式 | 难度 | 需要 | 适合场景 |
|------|------|------|----------|
| Fork 一键部署 | ⭐ | GitHub 账号 | 最简单，无需任何工具 |
| Cloudflare Worker 部署 | ⭐⭐ | Node.js 或浏览器 | 无服务器，零成本 |
| Docker 部署 | ⭐⭐⭐ | VPS + Docker | 自建服务器，完全自主 |

---

## 方式零：Fork 一键部署（推荐）

全程在浏览器中操作，无需安装任何工具，3 分钟完成。

### 前置要求

- 一个 GitHub 账号
- 一个 Cloudflare 账号（获取 Global API Key）

### 部署步骤

#### 1. Fork 仓库

点击本仓库右上角 **Fork** 按钮，将项目 Fork 到你自己的 GitHub 账号下。

#### 2. 获取 Cloudflare Global API Key

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. **API Keys** → **Global API Key** → **View**
3. 记录你的 API Key 和账号邮箱，稍后在运行 Action 时填入

#### 3. 运行部署 Action

有两种 Action 可选，**推荐使用 Secrets 版本**（更安全，敏感信息不会出现在日志中）。

**方式一：Secrets 版本（推荐）**

1. 进入 Fork 仓库 → **Settings** → **Environments** → **New environment**，创建一个环境（如 `production`）
2. 点击刚创建的环境 → **Environment secrets** → **Add secret**，依次添加：

| Secret 名称 | 说明 |
|---|---|
| `CF_GLOBAL_KEY` | Cloudflare Global API Key |
| `CF_EMAIL` | Cloudflare 账号邮箱 |
| `ENCRYPTION_KEY` | 加密密钥（可填 `cfmgrbest`） |
| `API_SECRET` | 访问密码（可填 `cfmgrbest`） |

3. 进入 **Actions** 标签 → 左侧选 **Deploy to Cloudflare Pages (Secrets)**
4. 点击 **Run workflow**，在 `environment` 输入环境名称（如 `production`），其他参数保持默认，点击绿色按钮运行

> 如有多个 Cloudflare 账户，可创建多个 Environment，每个配不同的密钥。部署时输入对应环境名即可。

**方式二：手动输入版本**

1. 进入 **Actions** 标签 → 左侧选 **Deploy to Cloudflare Pages**
2. 点击 **Run workflow**，填入参数：
   - `cf_global_key`：Cloudflare Global API Key
   - `cf_email`：Cloudflare 账号邮箱
   - `full_wipe`：勾选后可完全清空 D1 + KV 后重建（纯净部署）
   - 其他保持默认即可
3. 点击绿色 **Run workflow** 按钮

> 注意：方式二的凭据会出现在 Workflow run 的 **Inputs 元数据**中（对有权查看仓库 Actions 的协作者可见），但不会打印到步骤日志（已通过 `::add-mask::` 脱敏）。若需完全避免元数据暴露，建议使用方式一（Environment Secrets）。

#### 4. 等待部署完成

Action 会自动完成：
- 创建 D1 数据库并初始化
- 创建 KV 命名空间并绑定
- 构建前端和后端代码
- 部署到 Cloudflare Pages
- 配置加密密钥和访问密码

#### 5. 访问

部署成功后，访问 `https://cfmgr.pages.dev/admin/`（如果修改了项目名，则为 `https://<项目名>.pages.dev/admin/`）。

默认密码：`cfmgrbest`

### 更新

再次运行 **Deploy to Cloudflare Pages (Secrets)** 或 **Deploy to Cloudflare Pages** Action 即可，数据库不会被覆盖。

如果需要同时更新同步上游仓库的改动：
1. 在 Fork 的 GitHub 页面点击 **Sync fork** 同步上游更新
2. 再运行部署 Action

---

## 方式一：Docker 部署

适合有自建服务器（VPS）的用户。单容器包含 Node.js 后端 + 前端静态文件，无需 Nginx。

### 前置要求

- Docker 和 Docker Compose
- 一台可以访问 Cloudflare API 的服务器（或配置代理）

### 方式 A：使用预构建镜像（推荐）

无需克隆仓库，直接拉取镜像运行：

```bash
docker run -d --name cf-manager -p 3000:3000 \
  -e ENCRYPTION_KEY="cfmgrbest" \
  -e API_SECRET="cfmgrbest" \
  -v ./data:/app/data \
  --restart unless-stopped \
  ghcr.io/hefy2027/cf-manager:latest
```

> ⚠️ 请在生产环境前将 `ENCRYPTION_KEY` 和 `API_SECRET` 修改为自己的强密码。

访问 `http://<your-server-ip>:3000`。

### 方式 B：从源码构建

```bash
# 1. 克隆项目
git clone https://github.com/hefy2027/cf-manager.git
cd cf-manager

# 2. 创建配置文件
cp .env.example .env

# 3. 编辑 .env 配置
```

### 环境变量

编辑 `.env` 文件：

| 变量 | 必填 | 说明 |
|------|------|------|
| `ENCRYPTION_KEY` | 是 | 加密存储 API Token 的密钥（任意随机字符串，至少 16 位） |
| `API_SECRET` | 否 | 管理界面访问密码，留空则无需登录 |
| `PROXY_URL` | 否 | HTTP/SOCKS5 代理地址，如 `socks5://127.0.0.1:1080` |
| `APP_PORT` | 否 | 对外暴露端口，默认 `3000` |

### 启动服务

```bash
# 一键部署（构建 + 启动）
chmod +x deploy.sh
./deploy.sh

# 或手动启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

访问 `http://<your-server-ip>:3000`。

### 更新

```bash
# 预构建镜像方式
docker pull ghcr.io/hefy2027/cf-manager:latest
docker compose up -d  # 如果使用 docker-compose
# 或
docker stop cf-manager && docker rm cf-manager
# 重新 docker run

# 源码构建方式
git pull
./deploy.sh
```

### 数据持久化

- 数据库文件存储在本地 `./data/` 目录中（`/app/data/cf-manager.db`）
- 日志文件存储在 `/app/data/logs/`
- Docker Compose 已配置目录映射（`./data:/app/data`），数据不会随容器销毁丢失

### 本地开发

```bash
# 后端（http://localhost:3001）
cd backend
npm install
ENCRYPTION_KEY="dev-key" npm run dev

# 前端（http://localhost:5173，自动代理 /api 到后端）
cd frontend
npm install
npm run dev
```

### Docker 架构

```
                     ┌───────────────┐
  用户 ──── :3000 ──▶│  Node.js      │
                     │  Express 5    │
                     │               │
                     │  /api/*  → API│
                     │  /v1/*   → API│
                     │  /*      → SPA│
                     │               │
                     │  SQLite DB    │
                     └───────┬───────┘
                             │
                     ┌───────▼───────┐
                     │ Cloudflare    │
                     │    API        │
                     └───────────────┘
```

---

## 方式二：Cloudflare Worker 部署

适合无自建服务器的用户，完全运行在 Cloudflare 边缘网络上，免费计划即可使用。

### 优势

- **无需服务器**：运行在 Cloudflare 全球边缘节点
- **无需代理**：Worker 在 CF 内网直接调用 API，不存在 `socket hang up` 问题
- **零成本起步**：Workers Free 计划足够个人使用
- **全球加速**：就近节点响应，延迟极低

### 前置要求

- 一个 Cloudflare 账号
- Node.js 18+（用于构建）

有两种部署方式可选：

| | 方式 A：Dashboard 上传 | 方式 B：Wrangler CLI |
|---|---|---|
| 需要安装工具 | 不需要 | 需要 Wrangler CLI |
| D1 数据库创建 | Dashboard 网页操作 | 命令行操作 |
| 部署方式 | 网页上传 ZIP | 命令行一键部署 |
| 适合场景 | 不想装 CLI 的用户 | 熟悉命令行 / CI 自动化 |

---

### 方式 A：Dashboard 网页上传

全程在浏览器中操作，不需要安装 Wrangler CLI。

#### 1. 创建 D1 数据库与 KV 命名空间

**创建 D1 数据库：**

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单 → **Workers & Pages** → **D1 SQL Database**
3. 点击 **Create** → 名称填 `cf-manager` → 创建
4. 进入数据库详情页 → **Console** 标签
5. 将 `worker/src/db/schema.sql` 文件内容粘贴到控制台中执行

**创建 KV 命名空间：**

1. 左侧菜单 → **Workers & Pages** → **KV** → **Create a namespace**
2. 名称填 `cfmgr` → 创建（此命名空间用于缓存模型 schema、Quota 等运行时数据）

#### 2. 获取部署包

**方式一：直接下载（推荐）**

从 GitHub Releases 下载最新预构建包，无需本地构建：

👉 [下载最新版 cf-manager.zip](https://github.com/hefy2027/cf-manager/releases/latest/download/cf-manager.zip)

或访问 [Releases 页面](https://github.com/hefy2027/cf-manager/releases) 选择特定版本。

**方式二：本地构建**

```bash
cd worker
npm install
npm run build
```

这一条命令会自动完成：
1. 安装前端依赖并构建（base=/admin/）
2. 复制前端资源到 `public/`
3. 将 Worker 后端 TypeScript 打包为 `public/_worker.js`
4. 自动压缩为 `worker/cf-manager.zip`

#### 3. 创建 Pages 项目并上传

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. 项目名称填 `cf-manager`
3. 上传 `worker/cf-manager.zip`
4. 等待部署完成

#### 4. 配置 Bindings 和环境变量

部署完成后，进入项目设置：

1. **Settings** → **Bindings** → **Add** → **D1 Database**
   - Variable name: `DB`
   - D1 database: 选择 `cf-manager`
2. **Settings** → **Bindings** → **Add** → **KV Namespace**
   - Variable name: `KV`
   - KV namespace: 选择第 1 步创建的 `cfmgr`
3. **Settings** → **Environment variables** → **Add**
   - `ENCRYPTION_KEY`：你的加密密钥（加密类型选 **Encrypt**）
   - `API_SECRET`：你的访问密码（可选，加密类型选 **Encrypt**）
4. 添加完 Bindings 后，需要**重新部署**才能生效（在 Deployments 中点击最新部署的 **Retry deployment**）

#### 5. 访问

部署成功后，访问 `https://cf-manager.<your-subdomain>.pages.dev/admin/`。

> 根路径显示伪装的 nginx 欢迎页面，管理界面固定通过 `/admin/` 路径访问。

#### 更新

1. 从 [Releases](https://github.com/hefy2027/cf-manager/releases/latest/download/cf-manager.zip) 下载最新版，或本地 `cd worker && npm run build` 重新构建
2. Dashboard → Pages → cf-manager → **Create deployment** → 上传新的 `cf-manager.zip`

---

### 方式 B：Wrangler CLI 部署

适合熟悉命令行或需要自动化部署的用户。

#### 1. 认证 Wrangler

两种方式任选其一：

```bash
# 方式一：交互式登录（会打开浏览器）
npx wrangler login

# 方式二：使用 API Token（无需浏览器，适合服务器/CI）
# 在 Cloudflare Dashboard → My Profile → API Tokens → Create Token
# 选择 "Edit Cloudflare Workers" 模板
export CLOUDFLARE_API_TOKEN="你的API Token"
# Windows PowerShell:
$env:CLOUDFLARE_API_TOKEN="你的API Token"
```

#### 2. 创建 D1 数据库

```bash
cd worker
npx wrangler d1 create cf-manager
```

记录输出的 `database_id`，填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cf-manager"
database_id = "你的数据库ID"
```

#### 3. 创建 KV 命名空间（可选但推荐）

```bash
npx wrangler kv namespace create cfmgr
```

将输出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "KV"
id = "你的KV命名空间ID"
```

> KV 命名空间用于缓存感知路由和并发请求保护，不配置也不影响核心功能。

#### 4. 初始化数据库表

```bash
npx wrangler d1 execute cf-manager --file=src/db/schema.sql --remote
```

#### 5. 设置 Secrets

```bash
# 加密密钥（必填，用于加密存储 API Token）
npx wrangler pages secret put ENCRYPTION_KEY
# 输入你的加密密钥

# 访问密码（可选，留空则无需登录）
npx wrangler pages secret put API_SECRET
# 输入你的密码
```

#### 6. 一键构建并部署

```bash
cd worker
npm install
npm run deploy
```

`npm run deploy` 自动完成全部流程：
1. 安装前端依赖并构建
2. 复制前端资源
3. 打包 Worker 后端代码
4. 生成 ZIP（备份）
5. 部署到 Cloudflare Pages

部署完成后，终端会输出访问 URL（如 `https://cf-manager.your-subdomain.pages.dev/admin/`）。

> 根路径显示伪装的 nginx 欢迎页面，管理界面固定通过 `/admin/` 路径访问。

#### 更新

```bash
git pull
cd worker && npm run deploy
```

---

### 自定义域名

在 Cloudflare Dashboard → Pages → 你的项目 → **Custom domains** 中添加域名（输入你的域名，系统会自动添加 CNAME 并签发证书）。

> 注意：Cloudflare Pages 的自定义域名目前只能通过 Dashboard 或 API 配置，**没有** `wrangler pages project add-domain` 之类的 CLI 命令，请勿使用 CLI 添加。

### Worker 架构

```
                     ┌──────────────────┐
  用户 ──── HTTPS ──▶│  Cloudflare Edge │
                     │                  │
                     │  /        → Fake │
                     │            Nginx │
                     │  /admin/* → SPA  │
                     │  /api/*  → API   │
                     │  /v1/*   → API   │
                     │                  │
                     │  ┌────────────┐  │
                     │  │ Hono App   │  │
                     │  │ + D1 + KV  │  │
                     │  └─────┬──────┘  │
                     │        │ (内网)   │
                     │  ┌─────▼──────┐  │
                     │  │ CF REST API│  │
                     │  └────────────┘  │
                     └──────────────────┘
```

### 限制说明

| 项目 | Free 计划 | Paid 计划 |
|------|-----------|-----------|
| 请求数 | 100,000/天 | 无限制 |
| CPU 时间 | 10ms/请求 | 最高 5 分钟 |
| D1 读取 | 500 万行/天 | 250 亿行/月 |
| D1 写入 | 10 万行/天 | 5000 万行/月 |
| D1 存储 | 5 GB | 5 GB + 按量 |
| 内存 | 128 MB | 128 MB |

对于个人使用的管理工具，Free 计划完全够用。

### 与 Docker 版本的区别

| 特性 | Docker 版本 | Worker 版本 |
|------|-------------|-------------|
| 数据库 | SQLite (本地文件) | D1 (Cloudflare 托管) |
| 缓存/并发控制 | Node Cache (内存) | KV + D1 兜底 |
| 代理支持 | 支持 HTTP/SOCKS5 · Resin 代理池（每账户 sticky IP） | 不需要（CF 内网） |
| 加密算法 | Node.js crypto | Web Crypto API |
| 定时任务 | node-cron | 不支持 |
| 日志 | 文件日志 + winston | console.log + Logpush |
| 部署方式 | docker run / docker compose | wrangler deploy |
| 数据迁移 | 不兼容（加密格式不同） | 需重新添加账户 |

---

## 常见问题

### Docker 版：Cloudflare API 请求 socket hang up

多账户并发请求时代理可能无法处理所有连接。解决方案：
- 使用更稳定的代理服务
- 启用 Resin 代理池（设置页 → Resin 代理池），为每个账户绑定稳定出口 IP
- 在设置页面切换代理开关临时关闭代理测试
- 改用 Worker 版本（无需代理）

### Worker 版：CPU 时间超限

Free 计划的 10ms CPU 限制可能导致复杂操作（如批量部署）失败。解决方案：
- 升级到 Workers Paid 计划（$5/月）
- 减少单次请求的并发账户数量

## v2.10.1 Dashboard 自动资源扫描

Docker 在服务监听后延迟启动持久化只读扫描，配置见 `.env.example` 的 `DASHBOARD_*`。Pages 用认证请求和 D1 分批推进；Pages 本身没有 Cron，如需无人访问时仍持续运行，可选独立 `worker/wrangler.dashboard-scheduler.toml`，绑定同一 D1 并配置相同 ENCRYPTION_KEY。

升级需先备份，D1 应用 `0014_dashboard_scan.sql` 后整体发布前后端；Docker 自动幂等升级。不改变现有凭据密文/Account 主键。扫描策略、运行时限制、验收与回滚详见 [v2.10.1 技术说明](dashboard-v2.10.1.md)。

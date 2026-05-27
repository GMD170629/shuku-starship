# 书库星舰（shuku-starship）

NAS 自托管读物管理系统 MVP。当前版本覆盖登录、书库路径配置、目录扫描、读物浏览、受控文件访问、TXT/PDF/图片漫画阅读和阅读进度保存。

## 技术栈

- Monorepo：pnpm workspace + Turborepo
- Web：Next.js App Router + React + TypeScript + Tailwind CSS
- ORM：Prisma + MySQL
- 队列：Redis + BullMQ
- Worker：独立扫描 Worker
- 部署：Docker Compose

## 本地开发

1. 安装依赖：

```bash
pnpm install
```

2. 准备环境变量：

```bash
cp .env.example .env
```

本地默认账号由 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 控制；未设置时使用 `admin@example.com` / `starshipnas`。

3. 启动 MySQL 和 Redis，并同步 Prisma schema：

```bash
pnpm --filter @shuku/database prisma:push
```

4. 启动 Web 和 Worker：

```bash
pnpm dev
pnpm --filter @shuku/scan-worker dev
```

健康检查：<http://localhost:3000/api/health>

## MVP 使用流程

1. 打开 `/login` 登录。
2. 在 `/settings` 保存一个可读书库路径，例如本机的 `/Users/you/books`。
3. 在 `/scan-tasks` 选择路径并开始扫描。
4. 扫描完成后进入 `/library` 浏览真实入库读物。
5. 打开详情页并进入 `/reader/:id` 阅读。
6. 阅读器会通过 `/api/files/:fileId` 流式访问文件，并通过进度 API 节流保存当前位置。

## 测试数据

仓库内置 `test-data/library`，包含：

- TXT：`test-data/library/novels/starship-library.txt`
- PDF：`test-data/library/pdf/reading-notes.pdf`
- 图片漫画目录：`test-data/library/comics/starship-pages`

Docker 中会挂载为 `/books`，可在设置页直接保存 `/books` 后扫描。

## 验收

自动验收命令：

```bash
pnpm acceptance
```

该脚本会执行依赖安装检查、Prisma generate、类型检查和构建。手工验收清单见 `docs/manual-acceptance.md`。

## Docker Compose

```bash
docker compose up --build
```

服务包含：

- `mysql`：MySQL 8.4
- `redis`：Redis 7
- `web`：Next.js Web/API，启动前执行 `prisma db push`
- `scan-worker`：BullMQ 扫描 Worker

默认访问：

- Web：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>

容器内测试书库路径：`/books`

## 生产部署（Docker Compose）

生产部署使用 `docker-compose.prod.yml`，包含 `web`、`scan-worker`、`mysql` 和 `redis`。Web 镜像使用 Next.js standalone build，Worker 使用独立生产镜像。

1. 准备环境变量：

```bash
cp .env.production.example .env
```

生产 compose 默认读取项目根目录的 `.env`。请务必修改 `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`DATABASE_URL`、`SESSION_SECRET`、`ADMIN_PASSWORD`。`DATABASE_URL` 中的密码需要与 `MYSQL_PASSWORD` 保持一致。如果你想保留 `.env.production` 文件名，也可以启动时额外传入 `--env-file .env.production`。

2. 准备持久化目录和 NAS 书库挂载点：

```bash
mkdir -p data/mysql data/redis data/storage/covers data/storage/indexes data/storage/temp data/storage/logs books
```

如果部署在 NAS 上，建议将真实书库目录挂载到项目目录的 `./books`，容器内固定路径是 `/books`，并在 `.env` 中保持 `BOOKS_ROOT=/books`。

3. 设置文件权限。

生产容器默认不会以 root 身份运行，`web` 和 `scan-worker` 使用 `.env` 中的 `PUID` / `PGID`。请把它们设置为 NAS 上拥有 `./books` 读取权限、并拥有 `./data/storage` 写入权限的用户和用户组 ID：

```bash
id
chown -R "$PUID:$PGID" data/storage books
```

MySQL 和 Redis 使用官方镜像自己的运行用户；不要让 `web` 或 `scan-worker` 以 root 运行，除非你明确接受容器写出的封面、索引和日志可能变成 root 拥有，从而导致 NAS 文件权限问题。

4. 启动：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

默认访问 <http://localhost:3000>，健康检查为 <http://localhost:3000/api/health>。

生产持久化目录：

- `./data/mysql`：MySQL 数据
- `./data/redis`：Redis AOF 数据
- `./data/storage/covers`：封面缓存
- `./data/storage/indexes`：归档索引
- `./data/storage/temp`：临时文件
- `./data/storage/logs`：运行日志
- `./books`：宿主机或 NAS 书库目录，挂载到容器内 `/books`

重启容器不会清空 MySQL、Redis、封面、索引或扫描用临时目录。替换 NAS 书库目录后，只要 `./books` 指向真实目录且当前 `PUID` / `PGID` 可读，就可以在设置页保存 `/books` 并发起扫描。

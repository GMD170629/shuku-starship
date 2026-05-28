# 真实数据部署说明

## 模式

生产环境保持：

```bash
DEMO_MODE=false
NEXT_PUBLIC_DEMO_MODE=false
```

系统不会在生产页面 import mock 数据。数据库为空时，Dashboard 显示 0，书库、扫描任务、移动端显示 empty state。

## 生产启动

```bash
curl -fsSL https://raw.githubusercontent.com/GMD170629/shuku-starship/main/docker-compose.prod.yml | docker compose -f - up -d
```

生产发布后不需要在部署机下载代码，也不需要安装 Node.js / pnpm。远端 compose 会直接拉取 `gamersgu/shuku-starship-web:prod`、`gamersgu/shuku-starship-scan-worker:prod` 和 `gamersgu/shuku-starship-migrator:prod`，先由 `migrate` 服务同步 Prisma schema，再启动 Web 和 Worker。

第一次试运行可以直接使用默认值启动；正式部署请通过 `.env` 或一行命令里的 `env ... sh -c 'curl ... | docker compose -f - up -d'` 覆盖：

- `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD`，如需外部数据库可覆盖 `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- `BOOKS_HOST_PATH`
- `PUID` / `PGID`

容器内书库路径固定是 `/books`。`BOOKS_HOST_PATH` 是宿主机或 NAS 上的真实书库目录，默认 `./books`。

## 迁移与初始化

生产环境的 schema 同步和管理员初始化都由 compose 内部完成：`migrate` 服务执行 Prisma schema 同步，`web` 启动前执行生产 seed，只创建管理员用户和基础 `SystemSetting`，不会创建示例书。需要演示数据时只能在开发环境单独运行：

```bash
DEMO_MODE=true pnpm db:seed:demo
```

生产部署不要运行 demo seed。真实读物来自 `/settings` 添加书库路径后，由 `/scan-tasks` 创建真实扫描任务写入数据库。

## 启动检查

Web 和 scan-worker 会检查：

- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_SECRET`
- `BOOKS_ROOT`
- `BOOKS_ROOT` 是否可读
- `STORAGE_ROOT` 是否可写

`/api/system/health` 和 `/api/health` 会返回检查结果。`DEMO_MODE=false` 且数据库为空是合法状态。

## Mock 清理清单

- Dashboard 固定统计已改为 `/api/dashboard/summary`
- 继续阅读已改为 `/api/dashboard/continue-reading`
- 最近新增已改为 `/api/dashboard/recent-books`
- 系统状态已改为 `/api/dashboard/system-status` 和 `/api/system/health`
- 书库、书架、移动端列表已改为 `/api/books`
- 详情页已改为 `/api/books/[id]`
- 阅读器已改为 `/api/books/[id]/content`、`/api/books/[id]/file`、`/api/books/[id]/pages`
- 扫描任务页使用真实扫描任务和 `ScanLog`
- 设置页使用 `LibraryPath`、`SystemSetting`、真实 health 和真实阅读进度更新时间
- Demo 数据保留在 `docs/demo/`、`scripts/demo/`，只能通过显式 `DEMO_MODE=true pnpm db:seed:demo` 写入。

## 验证结果

本次代码整理已完成静态 grep：

使用 `rg` 检查 mock 入口、固定统计和固定扫描目录。

运行时代码不再 import mock 数据；命中项仅剩文档、环境开关和显式 opt-in 的 `scripts/demo/`。

当前执行环境缺少 `pnpm` 可执行文件，未能在本机完成 `pnpm typecheck` 和端到端扫描验收。生产部署不依赖部署机安装 pnpm，请按 README 的远端 Docker Compose 命令完成最终验收。

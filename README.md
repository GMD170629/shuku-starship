# 书库星舰（shuku-starship）

NAS 自托管读物管理系统。当前版本面向真实 NAS / 家庭服务器部署，覆盖登录、EPUB/PDF/CBZ/ZIP 上传导入、监控文件夹实时导入、读物浏览、系统托管文件访问和阅读进度保存。

## 技术栈

- Monorepo：pnpm workspace + Turborepo
- Web：Next.js App Router + React + TypeScript + Tailwind CSS
- 数据库：MySQL，Python 启动时自动初始化 schema 和基础数据
- 后端：Python FastAPI API + Python 导入 Worker
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
默认 `DEMO_MODE=false`，页面和 API 不会加载示例读物。数据库为空时会显示空状态。

3. 启动 MySQL，并初始化数据库：

```bash
pnpm db:migrate
pnpm db:seed
```

API 服务启动时也会自动执行同一套 Python 数据库初始化；`pnpm db:seed` 只创建或更新管理员用户和基础系统设置，不创建示例读物。

4. 启动 Web、Python API 和 Python Worker：

```bash
pnpm dev:test
```

健康检查：<http://localhost:3000/api/health>

## MVP 使用流程

1. 打开 `/login` 登录。
2. 在 `/library` 上传 EPUB/PDF/CBZ/ZIP，或在 `/settings` 保存监控文件夹。
3. 导入完成后进入 `/library` 浏览真实入库读物。
5. 打开详情页并进入 `/reader/:id` 阅读。
5. 阅读器会通过系统托管文件流式访问 EPUB、PDF 或漫画页面，并通过进度 API 节流保存当前位置。

## 监控文件夹

Docker 默认把项目根目录的 `./monitor` 挂载为容器内 `/monitor`。本地开发或 NAS 部署时，请把入站读物目录挂载、同步或软链接到 `./monitor`，然后在设置页保存 `/monitor` 作为监控文件夹。

监控文件夹只是导入来源。手动上传会把 EPUB/PDF/CBZ/ZIP 复制到系统托管目录 `STORAGE_ROOT/library`；监控导入默认也会复制，也可以在设置页把单个监控文件夹改为“移动到项目文件夹”。移动模式会在导入成功后删除入站目录中的源文件，因此 `/monitor` 必须以可写方式挂载，且容器运行用户需要对 `MONITOR_HOST_PATH` 有写权限。阅读时使用系统托管目录中的文件，不再依赖原始入站路径。

## Demo 数据隔离

生产部署不要运行 demo seed。真实数据来自手动上传或监控文件夹实时导入。

- 默认：`DEMO_MODE=false`、`NEXT_PUBLIC_DEMO_MODE=false`
- 基础 seed：由 Python API 启动自动执行，也可手动运行 `pnpm db:seed`
- 演示 seed：`DEMO_MODE=true pnpm db:seed:demo`
- Demo 文件位置：`docs/demo/`、`scripts/demo/`

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
- `web`：统一应用容器，同时运行 Next.js Web、Python FastAPI API 和 Python 导入 Worker

默认访问：

- Web：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>

容器内监控根路径：`/monitor`
切换验证：

```bash
pnpm verify:python-backend
```

只验证 FastAPI 独立进程启动和健康检查：

```bash
pnpm smoke:python-api
```

只验证 Python Worker 独立进程启动、ready 文件和退出清理：

```bash
pnpm smoke:python-worker
```

验证 Python Worker 监控目录导入、任务落库和阅读单元写入：

```bash
pnpm smoke:python-worker-import
```

验证 Python 后端样本导入和 reader/file/page HTTP 链路：

```bash
pnpm smoke:python-sample
```

对真实书库目录做抽样导入和 reader/file/page HTTP 验证：

```bash
PYTHON_REAL_LIBRARY_SAMPLE_DIR=/path/to/books pnpm smoke:python-real-library
```

## 生产部署（Docker Compose）

生产部署使用远端 `docker-compose.prod.yml`，包含 `web` 和 `mysql`。部署机直接从 Docker Hub 拉取生产镜像，不需要下载项目代码、安装 Node.js / pnpm，或执行本地 Docker build。

生产镜像均发布为 `linux/amd64`：

- `gamersgu/shuku-starship-web:prod`：统一应用镜像，同时运行 Next.js Web、Python FastAPI API 和 Python Worker；API 启动时自动执行数据库初始化

最快启动方式：

```bash
curl -fsSL https://raw.githubusercontent.com/GMD170629/shuku-starship/main/docker-compose.prod.yml | docker compose -f - up -d
```

这条命令会在当前目录创建 `./data` 和 `./monitor` 持久化目录；容器内监控根路径固定是 `/monitor`。默认账号为 `admin@example.com` / `starshipnas`，仅适合首次试运行。

正式部署建议显式传入数据库密码、管理员密码和真实监控目录。会话密钥由容器首次启动时生成并保存在 `STORAGE_PATH` 下：

```bash
env MYSQL_PASSWORD='change-me' MYSQL_ROOT_PASSWORD='change-root-me' ADMIN_PASSWORD='change-this-admin-password' MONITOR_HOST_PATH='/volume1/inbox-books' sh -c 'curl -fsSL https://raw.githubusercontent.com/GMD170629/shuku-starship/main/docker-compose.prod.yml | docker compose -f - up -d'
```

如果不想把环境变量写在命令里，也可以在任意空目录创建 `.env`，然后运行同一条远端 compose 命令。生产 compose 默认读取当前目录的 `.env`，可配置项包括：

- `WEB_PORT`：Web 端口，默认 `3000`
- `PUID` / `PGID`：统一应用容器运行用户，默认 `1000:1000`
- `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD`，如需外部数据库可覆盖 `DATABASE_URL`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- `MONITOR_HOST_PATH`：宿主机监控目录，默认 `./monitor`
- `MYSQL_DATA_PATH` / `STORAGE_PATH`：宿主机持久化目录，默认在当前目录的 `./data` 下

生产容器默认不会以 root 身份运行，统一应用容器使用 `PUID` / `PGID`。请把它们设置为 NAS 上拥有 `MONITOR_HOST_PATH` 读取权限、并拥有 `STORAGE_PATH` 写入权限的用户和用户组 ID；如果某个监控文件夹使用“移动到项目文件夹”，还需要对 `MONITOR_HOST_PATH` 有写/删除权限：

```bash
id
chown -R "$PUID:$PGID" data/storage "$MONITOR_HOST_PATH"
```

MySQL 使用官方镜像自己的运行用户；不要让统一应用容器以 root 运行，除非你明确接受容器写出的封面、索引和日志可能变成 root 拥有，从而导致 NAS 文件权限问题。

查看状态和日志：

```bash
curl -fsSL https://raw.githubusercontent.com/GMD170629/shuku-starship/main/docker-compose.prod.yml | docker compose -f - ps
curl -fsSL https://raw.githubusercontent.com/GMD170629/shuku-starship/main/docker-compose.prod.yml | docker compose -f - logs -f web
```

默认访问 <http://localhost:3000>，健康检查为 <http://localhost:3000/api/health>。
生产启动会等待 MySQL 健康后启动统一应用容器；Python API 启动时自动初始化 schema、管理员用户和基础系统设置。健康检查会通过 Next.js 命中 Python API。数据库为空不会报错，页面显示空状态。

更新到最新生产镜像：

```bash
curl -fsSL https://raw.githubusercontent.com/GMD170629/shuku-starship/main/docker-compose.prod.yml | docker compose -f - up -d
```

生产持久化目录：

- `${MYSQL_DATA_PATH:-./data/mysql}`：MySQL 数据
- `${STORAGE_PATH:-./data/storage}`：封面、归档索引、临时文件和运行日志
- `${MONITOR_HOST_PATH:-./monitor}`：宿主机或 NAS 监控目录，挂载到容器内 `/monitor`；复制模式只需可读，移动模式需要可写

重启容器不会清空 MySQL、封面、索引或导入托管目录。替换 NAS 入站目录后，只要 `MONITOR_HOST_PATH` 指向真实目录且当前 `PUID` / `PGID` 可读，就可以在设置页保存 `/monitor` 作为复制模式监控文件夹；移动模式还会校验该路径可写。

更多部署说明见 `docs/DEPLOYMENT.md`。

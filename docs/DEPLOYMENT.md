# 真实数据部署说明

## 模式

生产环境保持：

```bash
DEMO_MODE=false
NEXT_PUBLIC_DEMO_MODE=false
```

系统不会在生产页面 import mock 数据。数据库为空时，Dashboard 显示 0，书库、导入任务、移动端显示 empty state。

## 生产启动

```bash
curl -fsSL https://raw.githubusercontent.com/GMD170629/shuku-starship/main/docker-compose.prod.yml | docker compose -f - up -d
```

生产发布后不需要在部署机下载代码，也不需要安装 Node.js / pnpm。远端 compose 会直接拉取 `gamersgu/shuku-starship-web:prod`；统一应用容器内同时运行 Next.js Web、Python FastAPI API 和 Python Worker，Python API 启动时自动初始化数据库 schema 和基础数据。

第一次试运行可以直接使用默认值启动；正式部署请通过 `.env` 或一行命令里的 `env ... sh -c 'curl ... | docker compose -f - up -d'` 覆盖：

- `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD`，如需外部数据库可覆盖 `DATABASE_URL`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- `MONITOR_HOST_PATH`
- `PUID` / `PGID`

容器内监控根路径固定是 `/monitor`。`MONITOR_HOST_PATH` 是宿主机或 NAS 上的入站读物目录，默认 `./monitor`。复制模式只读取入站文件；移动模式会在导入成功后删除源文件，因此需要 `/monitor` 可写，并且 `PUID` / `PGID` 对 `MONITOR_HOST_PATH` 有写/删除权限。会话密钥由容器首次启动时生成并保存在 `STORAGE_PATH` 下。

## 迁移与初始化

生产环境的 schema 同步和管理员初始化都由 Python API 启动流程完成：自动创建缺失表、初始化管理员用户和基础 `SystemSetting`，不会创建示例书。需要演示数据时只能在开发环境单独运行：

```bash
DEMO_MODE=true pnpm db:seed:demo
```

生产部署不要运行 demo seed。真实读物来自 `/library` 手动上传，或 `/settings` 添加监控文件夹后由 Worker 实时导入。

## 启动检查

统一应用容器会检查：

- `DATABASE_URL`
- `STORAGE_ROOT` 是否可写

`/api/system/health` 和 `/api/health` 会返回检查结果。`DEMO_MODE=false` 且数据库为空是合法状态。

## Mock 清理清单

- Dashboard 固定统计已改为 `/api/dashboard/summary`
- 继续阅读已改为 `/api/dashboard/continue-reading`
- 最近新增已改为 `/api/dashboard/recent-books`
- 系统状态已改为 `/api/dashboard/system-status` 和 `/api/system/health`
- 书库、书架、移动端列表已改为 `/api/works`
- 详情页已改为 `/api/works/[id]`
- 阅读器已改为 `/api/editions/[id]/file` 和 `/api/volumes/[id]/pages`
- 导入任务页使用真实 `ImportTask` 和 `ImportLog`
- 设置页使用 `MonitorFolder`、`SystemSetting`、真实 health 和真实阅读进度更新时间
- Demo 数据保留在 `docs/demo/`、`scripts/demo/`，只能通过显式 `DEMO_MODE=true pnpm db:seed:demo` 写入。

## 验证结果

本次代码整理已完成静态 grep：

使用 `rg` 检查 mock 入口、固定统计和旧扫描入口。

运行时代码不再 import mock 数据；命中项仅剩文档、环境开关和显式 opt-in 的 `scripts/demo/`。

执行 `pnpm typecheck` 和 `pnpm acceptance` 完成最终验收。

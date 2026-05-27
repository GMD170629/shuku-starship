# 真实数据部署说明

## 模式

生产环境保持：

```bash
DEMO_MODE=false
NEXT_PUBLIC_DEMO_MODE=false
```

系统不会在生产页面 import mock 数据。数据库为空时，Dashboard 显示 0，书库、扫描任务、移动端显示 empty state。

## 迁移与初始化

```bash
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` 只创建管理员用户和基础 `SystemSetting`，不会创建示例书。需要演示数据时单独运行：

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
- Demo 数据保留在 `docs/demo/`、`scripts/demo/`、`packages/shared/demo/`

## 验证结果

本次代码整理已完成静态 grep：

使用 `rg` 检查 mock 入口、固定统计和固定扫描目录。

命中仅剩 `packages/shared/demo/` 和 `scripts/demo/` 下的 demo 内容。

当前执行环境缺少 `pnpm` 可执行文件，未能在本机完成 `pnpm db:migrate`、`pnpm db:seed`、`pnpm typecheck` 和端到端扫描验收。部署环境安装 pnpm 后，请按 README 的最终验收流程执行。

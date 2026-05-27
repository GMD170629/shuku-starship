# 书库星舰（shuku-starship）

NAS 自托管读物管理系统的 Node.js 全栈 Monorepo 脚手架。

## 技术栈

- Monorepo：pnpm workspace + Turborepo
- Web：Next.js + React + TypeScript + Tailwind CSS
- ORM：Prisma（MySQL）
- 队列：Redis + BullMQ
- 后台任务：独立 Node Worker
- 部署：Docker Compose

## 目录结构

- `apps/web`：前端与 API（含 `/api/health`）
- `packages/database`：Prisma schema 与数据库客户端
- `packages/shared`：共享类型
- `packages/ui`：共享 UI 组件包（预留）
- `packages/scanner`：NAS 扫描核心（预留）
- `packages/reader-core`：阅读核心能力（预留）
- `workers/scan-worker`：BullMQ 扫描任务 Worker

## 本地开发

1. 安装依赖

```bash
pnpm install
```

2. 启动 Web（Next.js）

```bash
pnpm dev
```

3. 健康检查

打开 <http://localhost:3000/api/health>，应返回：

```json
{
  "status": "ok",
  "service": "shuku-starship"
}
```

## Docker Compose

1. 启动服务

```bash
docker compose up --build
```

将启动以下服务：
- `mysql`
- `redis`
- `web`
- `scan-worker`

2. 访问 Web

- 首页：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>

## 环境变量

复制示例：

```bash
cp .env.example .env
```

关键变量：
- `DATABASE_URL`
- `REDIS_URL`

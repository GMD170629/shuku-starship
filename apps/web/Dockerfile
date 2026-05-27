FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/scanner/package.json packages/scanner/package.json
COPY packages/reader-core/package.json packages/reader-core/package.json
COPY workers/scan-worker/package.json workers/scan-worker/package.json
RUN pnpm install

COPY . .
WORKDIR /app/apps/web
RUN pnpm build

EXPOSE 3000
CMD ["pnpm", "start"]

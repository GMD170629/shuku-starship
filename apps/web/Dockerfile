FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl \
  && corepack enable

COPY package.json pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/scanner/package.json packages/scanner/package.json
COPY packages/reader-core/package.json packages/reader-core/package.json
RUN pnpm install

COPY . .
RUN pnpm --filter @shuku/database prisma:generate \
  && pnpm --filter @shuku/web build

WORKDIR /app/apps/web

EXPOSE 3000
CMD ["pnpm", "start"]

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl \
  && corepack enable

COPY package.json pnpm-workspace.yaml turbo.json ./
COPY workers/scan-worker/package.json workers/scan-worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/scanner/package.json packages/scanner/package.json
RUN pnpm install

COPY packages ./packages
COPY workers/scan-worker ./workers/scan-worker
RUN pnpm --filter @shuku/database prisma:generate \
  && pnpm --filter @shuku/scanner build \
  && pnpm --filter @shuku/scan-worker build

WORKDIR /app/workers/scan-worker

CMD ["pnpm", "start"]

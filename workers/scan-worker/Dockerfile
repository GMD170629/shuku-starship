FROM node:20-alpine
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml turbo.json ./
COPY workers/scan-worker/package.json workers/scan-worker/package.json
RUN pnpm install

COPY workers/scan-worker ./workers/scan-worker
WORKDIR /app/workers/scan-worker
RUN pnpm build

CMD ["pnpm", "start"]

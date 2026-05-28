import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { existsSync, readFileSync } from 'node:fs';
import { access, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { configuredScanQueueName, normalizeConfiguredPath, recoverStaleRunningScanTasks, scanNas } from '@shuku/scanner';

const readyFile = '/tmp/scan-worker-ready';

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  const env = readFileSync(path, 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile(join(process.env.INIT_CWD || process.cwd(), '.env'));
loadEnvFile(join(process.cwd(), '../../.env'));
if (process.env.BOOKS_ROOT) process.env.BOOKS_ROOT = normalizeConfiguredPath(process.env.BOOKS_ROOT);
if (process.env.STORAGE_ROOT) process.env.STORAGE_ROOT = normalizeConfiguredPath(process.env.STORAGE_ROOT);

async function startupCheck() {
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BOOKS_ROOT']) {
    if (!process.env[name]) throw new Error(`[scan-worker] missing required env ${name}`);
  }
  const booksRoot = process.env.BOOKS_ROOT;
  if (booksRoot) {
    const rootStat = await stat(booksRoot);
    if (!rootStat.isDirectory()) throw new Error(`[scan-worker] BOOKS_ROOT is not a directory: ${booksRoot}`);
    await access(booksRoot, constants.R_OK);
  }
}

await startupCheck();
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});

const recovered = await recoverStaleRunningScanTasks({ resume: true });
if (recovered > 0) console.warn(`[scan-worker] recovered ${recovered} stale running scan task(s)`);

const worker = new Worker(
  configuredScanQueueName(),
  async (job) => {
    console.log(`[scan-worker] processing job ${job.id}`, job.data);
    await scanNas(job.data);
    return { ok: true };
  },
  { connection: connection as never }
);

worker.on('ready', () => {
  void writeFile(readyFile, String(process.pid));
  console.log('[scan-worker] ready');
});
worker.on('completed', (job) => console.log(`[scan-worker] completed ${job.id}`));
worker.on('failed', (job, err) => console.error(`[scan-worker] failed ${job?.id}`, err));

async function shutdown(signal: string) {
  console.log(`[scan-worker] ${signal} received, closing worker`);
  await rm(readyFile, { force: true });
  await worker.close();
  connection.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

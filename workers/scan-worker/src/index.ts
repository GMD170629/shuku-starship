import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { rm, writeFile } from 'node:fs/promises';
import { recoverStaleRunningScanTasks, scanNas } from '@shuku/scanner';

const readyFile = '/tmp/scan-worker-ready';
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});

const recovered = await recoverStaleRunningScanTasks({ resume: true });
if (recovered > 0) console.warn(`[scan-worker] recovered ${recovered} stale running scan task(s)`);

const worker = new Worker(
  'scan-jobs',
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

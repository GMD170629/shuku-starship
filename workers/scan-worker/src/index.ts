import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});

const worker = new Worker(
  'scan-jobs',
  async (job) => {
    console.log(`[scan-worker] processing job ${job.id}`, job.data);
    return { ok: true };
  },
  { connection }
);

worker.on('ready', () => console.log('[scan-worker] ready'));
worker.on('completed', (job) => console.log(`[scan-worker] completed ${job.id}`));
worker.on('failed', (job, err) => console.error(`[scan-worker] failed ${job?.id}`, err));

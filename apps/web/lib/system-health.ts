import { access, mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { prisma } from './prisma';

export type CheckStatus = 'ok' | 'error' | 'unknown';

export type HealthCheck = {
  name: string;
  status: CheckStatus;
  message: string;
};

export type SystemHealth = {
  status: CheckStatus;
  demoMode: boolean;
  checks: HealthCheck[];
};

function envCheck(name: string, required = true): HealthCheck {
  const value = process.env[name];
  if (!value && required) return { name, status: 'error', message: `${name} 未配置` };
  return { name, status: value ? 'ok' : 'unknown', message: value ? '已配置' : '未配置' };
}

export function isDemoMode() {
  return process.env.DEMO_MODE === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

export async function runSystemHealthChecks(): Promise<SystemHealth> {
  const checks: HealthCheck[] = [
    envCheck('DATABASE_URL'),
    envCheck('REDIS_URL'),
    envCheck('SESSION_SECRET', process.env.NODE_ENV === 'production'),
    envCheck('BOOKS_ROOT')
  ];

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push({ name: 'database', status: 'ok', message: '数据库可连接' });
  } catch (error) {
    checks.push({ name: 'database', status: 'error', message: `数据库不可用：${String(error)}` });
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1000 });
    try {
      await redis.connect();
      await redis.ping();
      checks.push({ name: 'redis', status: 'ok', message: 'Redis 可连接' });
    } catch (error) {
      checks.push({ name: 'redis', status: 'error', message: `Redis 不可用：${String(error)}` });
    } finally {
      redis.disconnect();
    }
  }

  const booksRoot = process.env.BOOKS_ROOT;
  if (booksRoot) {
    try {
      const rootStat = await stat(booksRoot);
      await access(booksRoot, constants.R_OK);
      checks.push({ name: 'booksRootReadable', status: rootStat.isDirectory() ? 'ok' : 'error', message: rootStat.isDirectory() ? 'BOOKS_ROOT 可读' : 'BOOKS_ROOT 不是目录' });
    } catch (error) {
      checks.push({ name: 'booksRootReadable', status: 'error', message: `BOOKS_ROOT 不可读：${String(error)}` });
    }
  }

  const storageRoot = process.env.STORAGE_ROOT ?? './storage';
  try {
    await mkdir(storageRoot, { recursive: true });
    const probe = join(storageRoot, `.health-${process.pid}-${Date.now()}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    checks.push({ name: 'storageWritable', status: 'ok', message: '存储目录可写' });
  } catch (error) {
    checks.push({ name: 'storageWritable', status: 'error', message: `存储目录不可写：${String(error)}` });
  }

  return {
    status: checks.some((check) => check.status === 'error') ? 'error' : 'ok',
    demoMode: isDemoMode(),
    checks
  };
}

export async function assertProductionStartup() {
  if (process.env.NODE_ENV !== 'production') return;
  const health = await runSystemHealthChecks();
  const requiredFailures = health.checks.filter((check) => ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BOOKS_ROOT'].includes(check.name) && check.status === 'error');
  if (requiredFailures.length > 0) {
    throw new Error(`生产启动检查失败：${requiredFailures.map((check) => check.message).join('；')}`);
  }
}

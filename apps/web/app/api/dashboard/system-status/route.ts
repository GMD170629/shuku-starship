import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';
import { runSystemHealthChecks } from '../../../../lib/system-health';

export async function GET() {
  await requireUser();
  const [health, enabledLibraryPaths, currentRunningScanTask, latestScanTask, errorAgg] = await Promise.all([
    runSystemHealthChecks(),
    prisma.libraryPath.findMany({ where: { enabled: true }, orderBy: { createdAt: 'desc' } }),
    prisma.scanTask.findFirst({
      where: { status: { in: ['QUEUED', 'RUNNING', 'WAITING_RESUME'] } },
      orderBy: { createdAt: 'desc' },
      include: { libraryPath: true }
    }),
    prisma.scanTask.findFirst({ orderBy: { createdAt: 'desc' }, include: { libraryPath: true } }),
    prisma.scanTask.aggregate({ _sum: { errorCount: true } })
  ]);

  const check = (name: string) => health.checks.find((item) => item.name === name);
  return ok({
    database: check('database') ?? { status: 'unknown', message: '待检测' },
    redis: check('redis') ?? { status: 'unknown', message: '待检测' },
    worker: currentRunningScanTask?.heartbeatAt ? { status: 'ok', message: `最近心跳 ${currentRunningScanTask.heartbeatAt.toISOString()}` } : { status: 'unknown', message: '待检测' },
    enabledLibraryPaths,
    currentRunningScanTask,
    latestScanTask,
    errorFileCount: errorAgg._sum.errorCount ?? 0,
    booksRootReadable: check('booksRootReadable') ?? { status: 'unknown', message: '待检测' },
    storageWritable: check('storageWritable') ?? { status: 'unknown', message: '待检测' }
  });
}

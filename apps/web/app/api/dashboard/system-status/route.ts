import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';
import { runSystemHealthChecks } from '../../../../lib/system-health';

export async function GET() {
  await requireUser();
  const [health, enabledMonitorFolders, currentImportTask, latestImportTask, errorCount] = await Promise.all([
    runSystemHealthChecks(),
    prisma.monitorFolder.findMany({ where: { enabled: true }, orderBy: { createdAt: 'desc' } }),
    prisma.importTask.findFirst({
      where: { status: { in: ['PENDING', 'PARSING'] } },
      orderBy: { createdAt: 'desc' },
      include: { monitorFolder: true }
    }),
    prisma.importTask.findFirst({ orderBy: { createdAt: 'desc' }, include: { monitorFolder: true } }),
    prisma.importTask.count({ where: { status: 'FAILED' } })
  ]);

  const check = (name: string) => health.checks.find((item) => item.name === name);
  return ok({
    database: check('database') ?? { status: 'unknown', message: '待检测' },
    worker: enabledMonitorFolders.length > 0 ? { status: 'ok', message: '导入 Worker 监听监控文件夹' } : { status: 'unknown', message: '未启用监控文件夹' },
    enabledMonitorFolders,
    currentImportTask,
    latestImportTask,
    errorFileCount: errorCount,
    monitorRootReadable: check('monitorRootReadable') ?? { status: 'unknown', message: '待检测' },
    storageWritable: check('storageWritable') ?? { status: 'unknown', message: '待检测' }
  });
}

import { requireUser } from '../../../../lib/auth';
import { fail, ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

const ACTIVE_TASK_STALE_MS = Number(process.env.IMPORT_TASK_STALE_MS ?? 15 * 60 * 1000);

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  await reconcileActiveTask(params.id);
  const task = await prisma.importTask.findUnique({
    where: { id: params.id },
    include: {
      monitorFolder: true,
      work: { select: { id: true, title: true } },
      edition: { select: { id: true, versionName: true } },
      volume: { select: { id: true, title: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 100 }
    }
  });
  if (!task) return fail('导入任务不存在', 404);
  return ok({ task: serializeTask(task) });
}

async function reconcileActiveTask(id: string) {
  const staleBefore = new Date(Date.now() - ACTIVE_TASK_STALE_MS);
  const task = await prisma.importTask.findFirst({
    where: {
      id,
      status: { in: ['PENDING', 'PARSING'] },
      OR: [
        { logs: { some: { level: 'error' } } },
        { updatedAt: { lt: staleBefore } }
      ]
    },
    select: {
      id: true,
      startedAt: true,
      logs: {
        where: { level: 'error' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { message: true }
      }
    }
  });
  if (!task) return;
  const message = task.logs[0]?.message ?? `导入任务超过 ${Math.round(ACTIVE_TASK_STALE_MS / 60000)} 分钟没有进度更新，可能已中断`;
  await prisma.importTask.update({
    where: { id: task.id },
    data: {
      status: 'FAILED',
      progress: 100,
      errorSummary: message,
      message: '导入失败，详情见错误信息',
      duration: task.startedAt ? Math.max(0, Date.now() - task.startedAt.getTime()) : 0,
      finishedAt: new Date()
    }
  });
}

function serializeTask<T extends { sourcePath: string; managedFilePath: string | null; errorSummary: string | null }>(task: T) {
  const sourceName = task.sourcePath.split(/[\\/]/).filter(Boolean).at(-1) ?? task.sourcePath;
  const managedName = task.managedFilePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  return {
    ...task,
    sourcePath: sourceName,
    managedFilePath: managedName,
    friendlyError: friendlyError(task.errorSummary)
  };
}

function friendlyError(message: string | null) {
  const text = message ?? '';
  if (/EACCES|permission|权限/i.test(text)) return '权限不足：请确认容器用户可以读取该目录和文件。';
  if (/ENOENT|not found|不存在/i.test(text)) return '文件不存在：可能已被移动、删除，或监控目录配置已变化。';
  if (/unsupported|format|格式/i.test(text)) return '格式暂不支持：请确认文件是 EPUB、CBZ 或 ZIP。';
  if (/zip|archive|corrupt|invalid|损坏/i.test(text)) return '压缩包可能损坏：请重新复制文件或用本地工具测试压缩包。';
  return text ? '导入失败：请检查文件完整性和格式。' : null;
}

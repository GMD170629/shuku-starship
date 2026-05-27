import { requireUser } from '../../../../lib/auth';
import { fail, ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const task = await prisma.scanTask.findUnique({
    where: { id: params.id },
    include: { libraryPath: true, logs: { orderBy: { createdAt: 'desc' }, take: 100 } }
  });
  if (!task) return fail('扫描任务不存在', 404);
  return ok({ task });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action !== 'cancel') return fail('不支持的任务操作', 400);

  const task = await prisma.scanTask.findUnique({ where: { id: params.id } });
  if (!task) return fail('扫描任务不存在', 404);
  if (!['QUEUED', 'RUNNING', 'WAITING_RESUME'].includes(task.status)) return fail('该任务当前状态不能取消', 400);

  const updated = await prisma.scanTask.update({
    where: { id: params.id },
    data: {
      status: 'CANCELED',
      runningLockKey: null,
      message: task.status === 'RUNNING' ? '正在取消扫描，Worker 将在下一个安全点停止' : '扫描已取消',
      finishedAt: new Date()
    },
    include: { libraryPath: true, logs: { orderBy: { createdAt: 'desc' }, take: 100 } }
  });
  await prisma.scanLog.create({ data: { scanTaskId: params.id, level: 'warn', message: 'cancel requested by user' } });
  return ok({ task: updated });
}

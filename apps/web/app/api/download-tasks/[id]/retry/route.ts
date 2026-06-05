import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { sourceNamesById, toDownloadTaskView } from '../../../../../lib/download-tasks';
import { prisma } from '../../../../../lib/prisma';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const task = await prisma.downloadTask.updateMany({
    where: { id: params.id, status: { in: ['failed', 'cancelled'] } },
    data: { status: 'queued', progress: 0, errorMessage: null }
  });
  if (task.count === 0) return fail('只有失败或已取消任务可以重试', 400);
  const nextTask = await prisma.downloadTask.findUnique({ where: { id: params.id } });
  if (!nextTask) return fail('下载任务不存在', 404);
  const sources = nextTask.sourceId ? await prisma.source.findMany({ where: { id: nextTask.sourceId }, select: { id: true, name: true } }) : [];
  return ok({ task: toDownloadTaskView(nextTask, sourceNamesById(sources)) });
}

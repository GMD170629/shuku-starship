import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { sourceNamesById, toDownloadTaskView } from '../../../../../lib/download-tasks';
import { prisma } from '../../../../../lib/prisma';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const task = await prisma.downloadTask.update({
    where: { id: params.id },
    data: { status: 'cancelled', progress: null }
  }).catch(() => null);
  if (!task) return fail('下载任务不存在', 404);
  const sources = task.sourceId ? await prisma.source.findMany({ where: { id: task.sourceId }, select: { id: true, name: true } }) : [];
  return ok({ task: toDownloadTaskView(task, sourceNamesById(sources)) });
}

import { requireUser } from '../../../../../lib/auth';
import { executeDownloadTask } from '../../../../../lib/downloads/download-executor';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { sourceNamesById, toDownloadTaskView } from '../../../../../lib/download-tasks';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const existing = await prisma.downloadTask.findUnique({ where: { id: params.id } });
  if (!existing) return fail('下载任务不存在', 404);
  if (existing.status !== 'queued' && existing.status !== 'failed') {
    return fail('只有等待中或失败的任务可以开始下载', 400);
  }

  await executeDownloadTask(params.id);

  const task = await prisma.downloadTask.findUnique({ where: { id: params.id } });
  if (!task) return fail('下载任务不存在', 404);
  const sources = task.sourceId ? await prisma.source.findMany({ where: { id: task.sourceId }, select: { id: true, name: true } }) : [];
  return ok({ task: toDownloadTaskView(task, sourceNamesById(sources)) });
}

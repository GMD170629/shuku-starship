import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { importManagedBook } from '@shuku/scanner/managed-import';
import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { getResolvedDownloadInboxPath, sourceNamesById, toDownloadTaskView } from '../../../../../lib/download-tasks';

export const runtime = 'nodejs';

function errorSummary(error: unknown) {
  return (error instanceof Error ? error.message : '导入下载文件失败').slice(0, 500);
}

async function validateInboxFile(filePath: string | null) {
  if (!filePath) throw new Error('下载任务没有可导入文件');
  const inbox = await realpath(getResolvedDownloadInboxPath());
  const resolved = path.resolve(filePath);
  const relative = path.relative(inbox, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('只能导入 downloads/inbox 内的文件');
  const realFilePath = await realpath(resolved);
  const realRelative = path.relative(inbox, realFilePath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('只能导入 downloads/inbox 内的文件');
  const fileStat = await stat(realFilePath);
  if (!fileStat.isFile()) throw new Error('下载任务文件不存在或不是普通文件');
  return realFilePath;
}

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const task = await prisma.downloadTask.findUnique({ where: { id: params.id } });
  if (!task) return fail('下载任务不存在', 404);
  if (task.status !== 'downloaded') return fail('只有已下载任务可以导入书库', 400);

  let filePath: string;
  try {
    filePath = await validateInboxFile(task.filePath);
  } catch (error) {
    const message = errorSummary(error);
    await prisma.downloadTask.update({ where: { id: task.id }, data: { status: 'failed', errorMessage: message } });
    if (task.searchRecordId) {
      await prisma.sourceSearchRecord.update({ where: { id: task.searchRecordId }, data: { status: 'failed' } }).catch(() => undefined);
    }
    return fail(message, 400);
  }

  await prisma.downloadTask.update({
    where: { id: task.id },
    data: { status: 'importing', errorMessage: null }
  });

  try {
    const result = await importManagedBook({
      sourceFilePath: filePath,
      originalName: path.basename(filePath),
      origin: 'MANUAL'
    });
    const [updatedTask] = await prisma.$transaction([
      prisma.downloadTask.update({
        where: { id: task.id },
        data: {
          status: 'completed',
          bookId: result.bookId,
          progress: 100,
          errorMessage: null
        }
      }),
      ...(task.searchRecordId
        ? [prisma.sourceSearchRecord.update({ where: { id: task.searchRecordId }, data: { status: 'completed' } })]
        : [])
    ]);
    const sources = updatedTask.sourceId ? await prisma.source.findMany({ where: { id: updatedTask.sourceId }, select: { id: true, name: true } }) : [];
    return ok({ task: toDownloadTaskView(updatedTask, sourceNamesById(sources)), importResult: result });
  } catch (error) {
    const message = errorSummary(error);
    const [updatedTask] = await prisma.$transaction([
      prisma.downloadTask.update({
        where: { id: task.id },
        data: { status: 'failed', errorMessage: message }
      }),
      ...(task.searchRecordId
        ? [prisma.sourceSearchRecord.update({ where: { id: task.searchRecordId }, data: { status: 'failed' } })]
        : [])
    ]);
    const sources = updatedTask.sourceId ? await prisma.source.findMany({ where: { id: updatedTask.sourceId }, select: { id: true, name: true } }) : [];
    return ok({ task: toDownloadTaskView(updatedTask, sourceNamesById(sources)) }, { status: 400 });
  }
}

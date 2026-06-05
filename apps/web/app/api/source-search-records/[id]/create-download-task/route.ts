import { Prisma } from '@prisma/client';
import { requireUser } from '../../../../../lib/auth';
import { getDownloadInboxPath, hasUsableDownloadMeta, inferDownloadTaskType, sourceNamesById, toDownloadTaskView } from '../../../../../lib/download-tasks';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { toSourceSearchRecordView } from '../../../../../lib/sources/search-records';

const activeDownloadStatuses = ['queued', 'downloading', 'downloaded', 'importing', 'completed'];

function jsonInput(value: unknown) {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const record = await prisma.sourceSearchRecord.findUnique({
    where: { id: params.id },
    include: { source: { select: { id: true, name: true } } }
  });
  if (!record) return fail('搜索结果不存在', 404);
  if (!record.downloadAvailable) return fail('该搜索结果不可下载', 400);
  if (!hasUsableDownloadMeta(record.providerType, record.downloadMeta)) return fail('该搜索结果缺少可用下载信息', 400);

  const existingTask = await prisma.downloadTask.findFirst({
    where: {
      searchRecordId: record.id,
      status: { in: activeDownloadStatuses }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (existingTask) {
    const updatedRecord = record.status === 'download_created'
      ? record
      : await prisma.sourceSearchRecord.update({
          where: { id: record.id },
          data: { status: 'download_created' },
          include: { source: { select: { name: true } } }
        });
    const sources = record.source ? [record.source] : [];
    return ok({
      task: toDownloadTaskView(existingTask, sourceNamesById(sources)),
      record: toSourceSearchRecordView(updatedRecord),
      alreadyQueued: true
    });
  }

  const [task, updatedRecord] = await prisma.$transaction([
    prisma.downloadTask.create({
      data: {
        sourceId: record.sourceId,
        searchRecordId: record.id,
        type: inferDownloadTaskType(record.providerType, record.downloadMeta),
        status: 'queued',
        displayName: record.title,
        remoteRef: jsonInput(record.downloadMeta),
        savePath: getDownloadInboxPath(),
        progress: 0
      }
    }),
    prisma.sourceSearchRecord.update({
      where: { id: record.id },
      data: { status: 'download_created' },
      include: { source: { select: { name: true } } }
    })
  ]);
  const sources = record.source ? [record.source] : [];
  return ok({
    task: toDownloadTaskView(task, sourceNamesById(sources)),
    record: toSourceSearchRecordView(updatedRecord)
  }, { status: 201 });
}

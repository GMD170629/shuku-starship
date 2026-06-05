import { Prisma } from '@prisma/client';
import { requireUser } from '../../../lib/auth';
import { createRemoteRefFromSearchRecord, getDownloadInboxPath, inferDownloadTaskType, parseDownloadTaskType, sanitizeRemoteRef, sourceNamesById, toDownloadTaskView, validateDownloadInboxPath } from '../../../lib/download-tasks';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

type DownloadTaskBody = {
  sourceId?: string | null;
  searchRecordId?: string | null;
  bookId?: string | null;
  type?: string;
  displayName?: string;
  remoteRef?: unknown;
  savePath?: string | null;
  filePath?: string | null;
};

function nullableId(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

export async function GET(request: Request) {
  await requireUser();
  const url = new URL(request.url);
  const status = url.searchParams.get('status')?.trim();
  const where: Prisma.DownloadTaskWhereInput = {};
  if (status && status !== 'all') where.status = status;
  const tasks = await prisma.downloadTask.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 300
  });
  const sourceIds = Array.from(new Set(tasks.map((task) => task.sourceId).filter(Boolean))) as string[];
  const sources = sourceIds.length ? await prisma.source.findMany({ where: { id: { in: sourceIds } }, select: { id: true, name: true } }) : [];
  return ok({ tasks: tasks.map((task) => toDownloadTaskView(task, sourceNamesById(sources))) });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<DownloadTaskBody>(request);
  const searchRecordId = nullableId(body.searchRecordId);
  const sourceId = nullableId(body.sourceId);
  const bookId = nullableId(body.bookId);
  const type = body.type ? parseDownloadTaskType(body.type) : null;
  if (body.type && !type) return fail('下载类型不正确', 400);

  const searchRecord = searchRecordId ? await prisma.sourceSearchRecord.findUnique({ where: { id: searchRecordId } }) : null;
  if (searchRecordId && !searchRecord) return fail('搜索结果不存在', 404);
  if (searchRecord && !searchRecord.downloadAvailable) return fail('该搜索结果不可下载', 400);

  const displayName = (body.displayName ?? searchRecord?.title ?? '').trim();
  if (!displayName) return fail('缺少名称', 400);

  let savePath: string | null;
  let filePath: string | null;
  try {
    savePath = validateDownloadInboxPath(body.savePath ?? getDownloadInboxPath(), 'savePath');
    filePath = validateDownloadInboxPath(body.filePath, 'filePath');
  } catch (error) {
    return fail(error instanceof Error ? error.message : '下载路径不正确', 400);
  }

  const task = await prisma.downloadTask.create({
    data: {
      sourceId: sourceId ?? searchRecord?.sourceId ?? null,
      searchRecordId: searchRecord?.id ?? searchRecordId,
      bookId,
      type: type ?? (searchRecord ? inferDownloadTaskType(searchRecord.providerType) : 'manual'),
      status: 'queued',
      displayName,
      remoteRef: body.remoteRef !== undefined ? sanitizeRemoteRef(body.remoteRef) : searchRecord ? createRemoteRefFromSearchRecord(searchRecord) : Prisma.DbNull,
      savePath,
      filePath,
      progress: 0
    }
  });
  if (searchRecord) {
    await prisma.sourceSearchRecord.update({ where: { id: searchRecord.id }, data: { status: 'download_created' } });
  }
  const sources = task.sourceId ? await prisma.source.findMany({ where: { id: task.sourceId }, select: { id: true, name: true } }) : [];
  return ok({ task: toDownloadTaskView(task, sourceNamesById(sources)) }, { status: 201 });
}

import { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { parseDownloadTaskStatus, parseDownloadTaskType, sanitizeRemoteRef, sourceNamesById, toDownloadTaskView, validateDownloadInboxPath } from '../../../../lib/download-tasks';
import { fail, ok, readJson } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

type DownloadTaskUpdateBody = {
  type?: string;
  status?: string;
  displayName?: string;
  remoteRef?: unknown;
  savePath?: string | null;
  filePath?: string | null;
  errorMessage?: string | null;
  progress?: number | null;
};

function nullableString(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.trim() || null;
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<DownloadTaskUpdateBody>(request);
  const data: Prisma.DownloadTaskUpdateInput = {};

  if (body.type !== undefined) {
    const type = parseDownloadTaskType(body.type);
    if (!type) return fail('下载类型不正确', 400);
    data.type = type;
  }
  if (body.status !== undefined) {
    const status = parseDownloadTaskStatus(body.status);
    if (!status) return fail('下载状态不正确', 400);
    data.status = status;
    if (status === 'downloaded' || status === 'completed') data.progress = 100;
    if (status !== 'failed') data.errorMessage = null;
  }
  if (body.displayName !== undefined) {
    const displayName = body.displayName.trim();
    if (!displayName) return fail('名称不能为空', 400);
    data.displayName = displayName;
  }
  if (body.remoteRef !== undefined) data.remoteRef = sanitizeRemoteRef(body.remoteRef);
  if (body.errorMessage !== undefined) data.errorMessage = nullableString(body.errorMessage);
  if (body.progress !== undefined) {
    if (body.progress === null) {
      data.progress = null;
    } else if (typeof body.progress === 'number' && Number.isFinite(body.progress)) {
      data.progress = Math.max(0, Math.min(100, body.progress));
    } else {
      return fail('进度不正确', 400);
    }
  }
  try {
    if (body.savePath !== undefined) data.savePath = validateDownloadInboxPath(body.savePath, 'savePath');
    if (body.filePath !== undefined) data.filePath = validateDownloadInboxPath(body.filePath, 'filePath');
  } catch (error) {
    return fail(error instanceof Error ? error.message : '下载路径不正确', 400);
  }

  const task = await prisma.downloadTask.update({ where: { id: params.id }, data }).catch(() => null);
  if (!task) return fail('下载任务不存在', 404);
  const sources = task.sourceId ? await prisma.source.findMany({ where: { id: task.sourceId }, select: { id: true, name: true } }) : [];
  return ok({ task: toDownloadTaskView(task, sourceNamesById(sources)) });
}

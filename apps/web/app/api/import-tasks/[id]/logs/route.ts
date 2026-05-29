import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const task = await prisma.importTask.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!task) return fail('导入任务不存在', 404);
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? 100)));
  const level = url.searchParams.get('level')?.toLowerCase();
  const where = { importTaskId: params.id, ...(level ? { level } : {}) };
  const [logs, total] = await Promise.all([
    prisma.importLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.importLog.count({ where })
  ]);
  return ok({ logs, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}

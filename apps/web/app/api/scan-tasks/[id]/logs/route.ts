import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

const allowedLevels = new Set(['info', 'warn', 'error']);

export async function GET(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get('pageSize') ?? 100) || 100));
  const requestedLevel = url.searchParams.get('level')?.toLowerCase();
  const level = requestedLevel && allowedLevels.has(requestedLevel) ? requestedLevel : undefined;

  const task = await prisma.scanTask.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!task) return fail('扫描任务不存在', 404);

  const where = { scanTaskId: params.id, ...(level ? { level } : {}) };
  const [total, logs] = await Promise.all([
    prisma.scanLog.count({ where }),
    prisma.scanLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);

  return ok({
    logs,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  });
}

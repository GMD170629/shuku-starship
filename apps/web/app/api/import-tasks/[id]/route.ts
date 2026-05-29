import { requireUser } from '../../../../lib/auth';
import { fail, ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const task = await prisma.importTask.findUnique({
    where: { id: params.id },
    include: {
      monitorFolder: true,
      book: { select: { id: true, title: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 100 }
    }
  });
  if (!task) return fail('导入任务不存在', 404);
  return ok({ task });
}

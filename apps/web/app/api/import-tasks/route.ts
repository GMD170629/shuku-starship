import { requireUser } from '../../../lib/auth';
import { ok } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

export async function GET() {
  await requireUser();
  const tasks = await prisma.importTask.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      monitorFolder: true,
      book: { select: { id: true, title: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 20 }
    }
  });
  return ok({ tasks });
}

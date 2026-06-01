import { requireUser } from '../../../../lib/auth';
import { toWorkView } from '../../../../lib/books';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET() {
  const user = await requireUser();
  const progress = await prisma.libraryReadingProgress.findFirst({
    where: { userId: user.id, work: { hidden: false }, edition: { hidden: false } },
    orderBy: { updatedAt: 'desc' },
    include: {
      work: {
        include: {
          editions: {
            where: { hidden: false },
            include: {
              files: { orderBy: { sortOrder: 'asc' } },
              volumes: { orderBy: { sortOrder: 'asc' } },
              progresses: { where: { userId: user.id }, take: 1 }
            }
          },
          progresses: { where: { userId: user.id }, take: 1 }
        }
      }
    }
  });
  if (!progress) return ok({ item: null });
  return ok({
    item: {
      book: toWorkView(progress.work),
      progress: progress.percent,
      lastReadAt: progress.updatedAt,
      chapter: progress.page ? `第 ${progress.page} 页` : null,
      position: progress.position
    }
  });
}

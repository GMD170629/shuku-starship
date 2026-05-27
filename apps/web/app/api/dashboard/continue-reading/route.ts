import { requireUser } from '../../../../lib/auth';
import { toBookView } from '../../../../lib/books';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET() {
  const user = await requireUser();
  const progress = await prisma.readingProgress.findFirst({
    where: { userId: user.id, book: { hidden: false } },
    orderBy: { updatedAt: 'desc' },
    include: {
      book: {
        include: {
          files: { orderBy: { sortOrder: 'asc' } },
          libraryPath: true,
          progresses: { where: { userId: user.id }, take: 1 }
        }
      }
    }
  });
  if (!progress) return ok({ item: null });
  return ok({
    item: {
      book: toBookView(progress.book),
      progress: progress.percent,
      lastReadAt: progress.updatedAt,
      chapter: progress.page ? `第 ${progress.page} 页` : null,
      position: progress.position
    }
  });
}

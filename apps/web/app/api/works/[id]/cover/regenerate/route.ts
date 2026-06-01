import { requireUser } from '../../../../../../lib/auth';
import { fail, ok } from '../../../../../../lib/http';
import { toWorkView } from '../../../../../../lib/books';
import { prisma } from '../../../../../../lib/prisma';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const work = await prisma.libraryWork.findFirst({
    where: { id: params.id, hidden: false },
    include: {
      editions: {
        include: {
          files: { orderBy: { sortOrder: 'asc' } },
          volumes: { orderBy: { sortOrder: 'asc' } },
          progresses: { where: { userId: user.id }, take: 1 }
        }
      },
      progresses: { where: { userId: user.id }, take: 1 }
    }
  });
  if (!work) return fail('读物不存在或无权访问', 404);
  const primary = work.editions.find((edition) => edition.id === work.primaryEditionId) ?? work.editions[0];
  if (primary?.coverPath && !work.coverPath) {
    await prisma.libraryWork.update({ where: { id: work.id }, data: { coverPath: primary.coverPath, coverStatus: 'READY' } });
  }
  return ok({ book: toWorkView(work), coverStatus: work.coverPath || primary?.coverPath ? 'READY' : 'PENDING' });
}

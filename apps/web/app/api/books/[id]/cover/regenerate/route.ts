import { CoverService } from '@shuku/scanner/cover-service';
import { requireUser } from '../../../../../../lib/auth';
import { fail, ok } from '../../../../../../lib/http';
import { toBookView } from '../../../../../../lib/books';
import { prisma } from '../../../../../../lib/prisma';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const book = await prisma.book.findUnique({
    where: { id: params.id },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      libraryPath: true,
      progresses: { where: { userId: user.id }, take: 1 }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);
  const coverStatus = await CoverService.generateBookCover(book);
  const updated = await prisma.book.findUnique({
    where: { id: params.id },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      libraryPath: true,
      progresses: { where: { userId: user.id }, take: 1 }
    }
  });
  if (!updated) return fail('读物不存在或无权访问', 404);
  return ok({ book: toBookView(updated), coverStatus });
}

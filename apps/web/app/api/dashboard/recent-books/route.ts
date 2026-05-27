import { requireUser } from '../../../../lib/auth';
import { toBookView } from '../../../../lib/books';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const limit = Math.min(24, Math.max(1, Number(url.searchParams.get('limit') ?? 8)));
  const books = await prisma.book.findMany({
    where: { hidden: false },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      libraryPath: true,
      progresses: { where: { userId: user.id }, take: 1 }
    }
  });
  return ok({ books: books.map(toBookView) });
}

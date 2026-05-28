import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const book = await prisma.book.findUnique({ where: { id: params.id } });
  if (!book) return fail('读物不存在', 404);
  const chapters = await prisma.bookChapter.findMany({ where: { bookId: params.id }, orderBy: { sortOrder: 'asc' } });
  return ok({ chapters });
}

import { requireUser } from '../../../../../lib/auth';
import { mergeBookFiles, MergeBookError } from '../../../../../lib/book-merge';
import { toBookView } from '../../../../../lib/books';
import { fail, ok, readJson } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const body = await readJson<{ sourceBookId?: string }>(request);

  try {
    const result = await mergeBookFiles(prisma, params.id, String(body.sourceBookId ?? ''));
    const book = await prisma.book.findUnique({
      where: { id: params.id },
      include: {
        files: { orderBy: { sortOrder: 'asc' } },
        monitorFolder: true,
        progresses: { where: { userId: user.id }, take: 1 }
      }
    });
    if (!book) return fail('目标读物不存在', 404);
    return ok({ book: toBookView(book), mergedBookId: result.mergedBookId });
  } catch (error) {
    if (error instanceof MergeBookError) return fail(error.message, error.status);
    throw error;
  }
}

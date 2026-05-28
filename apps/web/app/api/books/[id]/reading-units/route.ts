import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: {
      readingUnits: { orderBy: { sortOrder: 'asc' } },
      chapters: { orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);
  const readingUnits = book.readingUnits.length
    ? book.readingUnits.map((unit) => ({ ...unit, size: unit.size ? Number(unit.size) : null, metadataJson: safeJson(unit.metadataJson) }))
    : book.chapters.map((chapter) => ({
        id: chapter.id,
        bookId: chapter.bookId,
        unitType: 'chapter',
        title: chapter.title,
        href: chapter.href,
        filePath: null,
        mediaType: chapter.mediaType,
        sortOrder: chapter.sortOrder,
        width: null,
        height: null,
        size: null,
        metadataJson: '{}',
        createdAt: chapter.createdAt,
        updatedAt: chapter.updatedAt
      }));
  return ok({ readingUnits, totalUnits: readingUnits.length });
}

function safeJson(value: string) {
  try { return JSON.parse(value); } catch { return value; }
}


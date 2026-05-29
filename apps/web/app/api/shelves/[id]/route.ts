import { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { toBookView } from '../../../../lib/books';
import { prisma } from '../../../../lib/prisma';

const bookInclude = (userId: string) => ({
  files: { orderBy: { sortOrder: Prisma.SortOrder.asc } },
  monitorFolder: true,
  progresses: { where: { userId }, take: 1 }
});

async function findShelf(id: string, userId: string) {
  return prisma.shelf.findUnique({
    where: { id },
    include: {
      books: {
        orderBy: { createdAt: 'desc' },
        include: {
          book: { include: bookInclude(userId) }
        }
      }
    }
  });
}

function serializeShelf(shelf: NonNullable<Awaited<ReturnType<typeof findShelf>>>) {
  return {
    id: shelf.id,
    name: shelf.name,
    description: shelf.description,
    bookCount: shelf.books.length,
    books: shelf.books.map((item) => toBookView(item.book)),
    createdAt: shelf.createdAt.toISOString(),
    updatedAt: shelf.updatedAt.toISOString()
  };
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const shelf = await findShelf(params.id, user.id);
  if (!shelf) return fail('书架不存在', 404);
  return ok({ shelf: serializeShelf(shelf) });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const body = await readJson<{ name?: string; description?: string; bookIds?: string[] }>(request);
  const data: Prisma.ShelfUpdateInput = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return fail('书架名称不能为空', 400);
    data.name = name;
  }
  if (typeof body.description === 'string') data.description = body.description.trim() || null;

  const existing = await prisma.shelf.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!existing) return fail('书架不存在', 404);

  if (Array.isArray(body.bookIds)) {
    if (Object.keys(data).length === 0) data.updatedAt = new Date();
    const bookIds = [...new Set(body.bookIds.map(String).filter(Boolean))];
    const books = bookIds.length
      ? await prisma.book.findMany({ where: { id: { in: bookIds }, hidden: false }, select: { id: true } })
      : [];
    const validBookIds = books.map((book) => book.id);
    await prisma.$transaction([
      prisma.shelf.update({ where: { id: params.id }, data }),
      prisma.shelfBook.deleteMany({ where: { shelfId: params.id } }),
      ...(validBookIds.length
        ? [prisma.shelfBook.createMany({ data: validBookIds.map((bookId) => ({ shelfId: params.id, bookId })), skipDuplicates: true })]
        : [])
    ]);
  } else if (Object.keys(data).length > 0) {
    await prisma.shelf.update({ where: { id: params.id }, data });
  }

  const shelf = await findShelf(params.id, user.id);
  if (!shelf) return fail('书架不存在', 404);
  return ok({ shelf: serializeShelf(shelf) });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  await prisma.shelf.delete({ where: { id: params.id } }).catch(() => null);
  return ok({ deleted: true });
}

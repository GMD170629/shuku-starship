import { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { toWorkView } from '../../../../lib/books';
import { prisma } from '../../../../lib/prisma';

const workInclude = (userId: string) => ({
  editions: {
    where: { hidden: false },
    include: {
      files: { orderBy: { sortOrder: Prisma.SortOrder.asc } },
      volumes: { orderBy: { sortOrder: Prisma.SortOrder.asc } },
      progresses: { where: { userId }, take: 1 }
    }
  },
  progresses: { where: { userId }, take: 1 }
});

async function findShelf(id: string, userId: string) {
  return prisma.shelf.findUnique({
    where: { id },
    include: {
      works: {
        orderBy: { createdAt: 'desc' },
        include: {
          work: { include: workInclude(userId) }
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
    bookCount: shelf.works.length,
    books: shelf.works.map((item) => toWorkView(item.work)),
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
  const body = await readJson<{ name?: string; description?: string; workIds?: string[]; bookIds?: string[] }>(request);
  const data: Prisma.ShelfUpdateInput = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return fail('书架名称不能为空', 400);
    data.name = name;
  }
  if (typeof body.description === 'string') data.description = body.description.trim() || null;

  const existing = await prisma.shelf.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!existing) return fail('书架不存在', 404);

  const requestedWorkIds = Array.isArray(body.workIds) ? body.workIds : body.bookIds;
  if (Array.isArray(requestedWorkIds)) {
    if (Object.keys(data).length === 0) data.updatedAt = new Date();
    const workIds = [...new Set(requestedWorkIds.map(String).filter(Boolean))];
    const works = workIds.length
      ? await prisma.libraryWork.findMany({ where: { id: { in: workIds }, hidden: false }, select: { id: true } })
      : [];
    const validWorkIds = works.map((work) => work.id);
    await prisma.$transaction([
      prisma.shelf.update({ where: { id: params.id }, data }),
      prisma.shelfWork.deleteMany({ where: { shelfId: params.id } }),
      ...(validWorkIds.length
        ? [prisma.shelfWork.createMany({ data: validWorkIds.map((workId) => ({ shelfId: params.id, workId })), skipDuplicates: true })]
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

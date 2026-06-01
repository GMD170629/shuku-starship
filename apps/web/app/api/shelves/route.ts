import { Prisma } from '@prisma/client';
import { requireUser } from '../../../lib/auth';
import { ok, fail, readJson } from '../../../lib/http';
import { toWorkView } from '../../../lib/books';
import { prisma } from '../../../lib/prisma';

const previewInclude = (userId: string) => ({
  work: {
    include: {
      editions: {
        where: { hidden: false },
        include: {
          files: { orderBy: { sortOrder: Prisma.SortOrder.asc } },
          volumes: { orderBy: { sortOrder: Prisma.SortOrder.asc } },
          progresses: { where: { userId }, take: 1 }
        }
      },
      progresses: { where: { userId }, take: 1 }
    }
  }
});

function serializeShelf(
  shelf: Prisma.ShelfGetPayload<{
    include: {
      _count: { select: { works: true } };
      works: { include: ReturnType<typeof previewInclude>; orderBy: { createdAt: 'desc' }; take: 4 };
    };
  }>
) {
  return {
    id: shelf.id,
    name: shelf.name,
    description: shelf.description,
    bookCount: shelf._count.works,
    books: shelf.works.map((item) => toWorkView(item.work)),
    createdAt: shelf.createdAt.toISOString(),
    updatedAt: shelf.updatedAt.toISOString()
  };
}

export async function GET() {
  const user = await requireUser();
  const shelves = await prisma.shelf.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { works: true } },
      works: {
        orderBy: { createdAt: 'desc' },
        take: 4,
        include: previewInclude(user.id)
      }
    }
  });
  return ok({ shelves: shelves.map(serializeShelf) });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ name?: string; description?: string }>(request);
  const name = body.name?.trim();
  if (!name) return fail('书架名称不能为空', 400);
  const shelf = await prisma.shelf.create({
    data: {
      name,
      description: body.description?.trim() || null
    }
  });
  return ok({
    shelf: {
      id: shelf.id,
      name: shelf.name,
      description: shelf.description,
      bookCount: 0,
      books: [],
      createdAt: shelf.createdAt.toISOString(),
      updatedAt: shelf.updatedAt.toISOString()
    }
  }, { status: 201 });
}

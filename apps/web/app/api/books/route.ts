import type { Prisma } from '@prisma/client';
import { requireUser } from '../../../lib/auth';
import { ok } from '../../../lib/http';
import { toBookView } from '../../../lib/books';
import { prisma } from '../../../lib/prisma';
import { parseReadingFormat } from '../../../lib/book-metadata';

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const pageSize = Math.min(60, Math.max(1, Number(url.searchParams.get('pageSize') ?? 24)));
  const search = (url.searchParams.get('search') ?? url.searchParams.get('keyword'))?.trim();
  const format = url.searchParams.get('format')?.trim();
  const type = url.searchParams.get('type')?.trim();
  const sort = url.searchParams.get('sort') ?? 'updated';
  const visibility = url.searchParams.get('visibility') ?? 'active';

  const where: Prisma.BookWhereInput = {};
  if (visibility === 'ignored') where.hidden = true;
  else if (visibility !== 'all') where.hidden = false;
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { author: { contains: search } },
      { tags: { contains: search } },
      { sourcePath: { contains: search } }
    ];
  }
  if (type === 'ebook') where.format = { in: ['EPUB'] };
  if (type === 'comic') where.format = 'COMIC';
  if (format && format !== '全部') {
    const normalized = format.trim().toLowerCase();
    if (normalized === 'cbz') {
      where.format = 'COMIC';
      where.sourcePath = { endsWith: '.cbz' };
    } else if (normalized === 'zip') {
      where.format = 'COMIC';
      where.sourcePath = { endsWith: '.zip' };
    } else {
      const parsedFormat = parseReadingFormat(format);
      if (parsedFormat) where.format = parsedFormat;
    }
  }

  const orderBy: Prisma.BookOrderByWithRelationInput =
    sort === 'title' ? { title: 'asc' } : sort === 'created' ? { createdAt: 'desc' } : { updatedAt: 'desc' };

  const [total, books] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        files: { orderBy: { sortOrder: 'asc' } },
        libraryPath: true,
        progresses: { where: { userId: user.id }, take: 1 }
      }
    })
  ]);

  return ok({
    books: books.map(toBookView),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  });
}

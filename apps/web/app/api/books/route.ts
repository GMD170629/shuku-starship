import type { Prisma, ReadingStatus } from '@prisma/client';
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
  const status = url.searchParams.get('status')?.trim();
  const tag = url.searchParams.get('tag')?.trim();
  const missingCover = url.searchParams.get('missingCover') === 'true';
  const newImport = url.searchParams.get('newImport') === 'true';

  const where: Prisma.BookWhereInput = {};
  if (visibility === 'ignored') where.hidden = true;
  else if (visibility !== 'all') where.hidden = false;
  if (search) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      {
        OR: [
          { title: { contains: search } },
          { author: { contains: search } },
          { tags: { contains: search } },
          { managedFilePath: { contains: search } }
        ]
      }
    ];
  }
  if (type === 'ebook') where.format = { in: ['EPUB'] };
  if (type === 'comic') where.format = 'COMIC';
  if (format && format !== '全部') {
    const normalized = format.trim().toLowerCase();
    if (normalized === 'cbz') {
      where.format = 'COMIC';
      where.managedFilePath = { endsWith: '.cbz' };
    } else if (normalized === 'zip') {
      where.format = 'COMIC';
      where.managedFilePath = { endsWith: '.zip' };
    } else {
      const parsedFormat = parseReadingFormat(format);
      if (parsedFormat) where.format = parsedFormat;
    }
  }
  if (status && status !== '全部') {
    const normalizedStatus = status.toUpperCase();
    if (['WANT', 'READING', 'FINISHED'].includes(normalizedStatus)) where.status = normalizedStatus as ReadingStatus;
  }
  if (tag) where.tags = { contains: tag };
  if (missingCover) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { OR: [{ coverPath: null }, { coverStatus: { not: 'READY' } }] }
    ];
  }
  if (newImport) where.organized = false;

  const orderBy: Prisma.BookOrderByWithRelationInput =
    sort === 'title'
      ? { title: 'asc' }
      : sort === 'author'
        ? { author: 'asc' }
        : sort === 'created' || sort === 'recent_import'
          ? { createdAt: 'desc' }
          : sort === 'progress'
            ? { updatedAt: 'desc' }
            : sort === 'recent_read'
              ? { updatedAt: 'desc' }
              : { updatedAt: 'desc' };

  const [total, books] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        files: { orderBy: { sortOrder: 'asc' } },
        monitorFolder: true,
        progresses: { where: { userId: user.id }, take: 1 }
      }
    })
  ]);

  const sortedBooks = [...books].sort((a, b) => {
    if (sort === 'progress') return (b.progresses[0]?.percent ?? 0) - (a.progresses[0]?.percent ?? 0);
    if (sort === 'recent_read') return (b.progresses[0]?.updatedAt?.getTime() ?? 0) - (a.progresses[0]?.updatedAt?.getTime() ?? 0);
    return 0;
  });

  return ok({
    books: sortedBooks.map(toBookView),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  });
}

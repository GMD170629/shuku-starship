import type { Prisma } from '@prisma/client';
import { requireUser } from '../../../lib/auth';
import { ok } from '../../../lib/http';
import { toWorkView } from '../../../lib/books';
import { prisma } from '../../../lib/prisma';
import { parsePublicationStatus, parseReadingFormat, parseReadingStatus, parseTrackingStatus } from '../../../lib/book-metadata';

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
  const publicationStatus = url.searchParams.get('publicationStatus')?.trim();
  const trackingStatus = url.searchParams.get('trackingStatus')?.trim();
  const tag = url.searchParams.get('tag')?.trim();
  const author = url.searchParams.get('author')?.trim();
  const series = url.searchParams.get('series')?.trim();
  const publishedYear = url.searchParams.get('publishedYear')?.trim();
  const missingCover = url.searchParams.get('missingCover') === 'true';
  const newImport = url.searchParams.get('newImport') === 'true';

  const where: Prisma.LibraryWorkWhereInput = {};
  if (visibility === 'ignored') where.hidden = true;
  else if (visibility !== 'all') where.hidden = false;
  if (search) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      {
        OR: [
          { title: { contains: search } },
          { author: { contains: search } },
          { seriesName: { contains: search } },
          { tags: { contains: search } },
          { editions: { some: { files: { some: { path: { contains: search } } } } } }
        ]
      }
    ];
  }
  if (type === 'ebook') where.workType = { in: ['EPUB'] };
  if (type === 'comic') where.workType = 'COMIC';
  if (format && format !== '全部') {
    const normalized = format.trim().toLowerCase();
    if (normalized === 'cbz') {
      where.workType = 'COMIC';
      where.editions = { some: { files: { some: { path: { endsWith: '.cbz' } } } } };
    } else if (normalized === 'zip') {
      where.workType = 'COMIC';
      where.editions = { some: { files: { some: { path: { endsWith: '.zip' } } } } };
    } else {
      const parsedFormat = parseReadingFormat(format);
      if (parsedFormat) where.workType = parsedFormat;
    }
  }
  if (status && status !== '全部') {
    const parsedStatus = parseReadingStatus(status);
    if (parsedStatus) where.status = parsedStatus;
  }
  if (publicationStatus && publicationStatus !== '全部') {
    const parsedPublicationStatus = parsePublicationStatus(publicationStatus);
    if (parsedPublicationStatus) where.publicationStatus = parsedPublicationStatus;
  }
  if (trackingStatus && trackingStatus !== '全部') {
    const parsedTrackingStatus = parseTrackingStatus(trackingStatus);
    if (parsedTrackingStatus) where.trackingStatus = parsedTrackingStatus;
  }
  if (tag) where.tags = { contains: tag };
  if (author) where.author = { contains: author };
  if (series) where.seriesName = { contains: series };
  if (publishedYear && /^\d{4}$/.test(publishedYear)) where.publishedYear = Number(publishedYear);
  if (missingCover) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { OR: [{ coverPath: null }, { coverStatus: { not: 'READY' } }] }
    ];
  }
  if (newImport) where.organized = false;

  const orderBy: Prisma.LibraryWorkOrderByWithRelationInput =
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

  const [total, works] = await Promise.all([
    prisma.libraryWork.count({ where }),
    prisma.libraryWork.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        editions: {
          where: { hidden: false },
          orderBy: [{ primary: 'desc' }, { createdAt: 'asc' }],
          include: {
            files: { orderBy: { sortOrder: 'asc' } },
            volumes: { orderBy: { sortOrder: 'asc' } },
            progresses: { where: { userId: user.id }, take: 1 }
          }
        },
        progresses: { where: { userId: user.id }, take: 1 }
      }
    })
  ]);

  const sortedWorks = [...works].sort((a, b) => {
    const progressA = a.editions.flatMap((edition) => edition.progresses).sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime())[0];
    const progressB = b.editions.flatMap((edition) => edition.progresses).sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime())[0];
    if (sort === 'progress') return (progressB?.percent ?? 0) - (progressA?.percent ?? 0);
    if (sort === 'recent_read') return (progressB?.updatedAt?.getTime() ?? 0) - (progressA?.updatedAt?.getTime() ?? 0);
    return 0;
  });

  return ok({
    books: sortedWorks.map(toWorkView),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  });
}

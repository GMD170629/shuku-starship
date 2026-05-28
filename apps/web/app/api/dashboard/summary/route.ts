import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET() {
  await requireUser();
  const [totalBooks, comicBooks, novelBooks, pdfBooks, documentBooks, storage, libraryPathCount, lastScan, latestProgress] = await Promise.all([
    prisma.book.count({ where: { hidden: false } }),
    prisma.book.count({ where: { hidden: false, format: 'COMIC' } }),
    prisma.book.count({ where: { hidden: false, format: { in: ['TXT', 'EPUB'] } } }),
    prisma.book.count({ where: { hidden: false, format: 'PDF' } }),
    prisma.book.count({ where: { hidden: false, format: { in: ['IMAGE', 'UNKNOWN'] } } }),
    prisma.book.aggregate({ where: { hidden: false }, _sum: { sizeBytes: true } }),
    prisma.libraryPath.count({ where: { enabled: true } }),
    prisma.scanTask.findFirst({ where: { status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, updatedAt: true } }),
    prisma.readingProgress.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } })
  ]);

  return ok({
    totalBooks,
    comicBooks,
    novelBooks,
    pdfBooks,
    documentBooks,
    storageUsedBytes: Number(storage._sum.sizeBytes ?? BigInt(0)),
    libraryPathCount,
    lastScanAt: lastScan?.finishedAt ?? lastScan?.updatedAt ?? null,
    latestSyncAt: latestProgress?.updatedAt ?? null
  });
}

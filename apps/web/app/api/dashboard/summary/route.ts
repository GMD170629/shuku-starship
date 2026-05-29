import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET() {
  await requireUser();
  const [totalBooks, comicBooks, novelBooks, storage, monitorFolderCount, lastImport, latestProgress] = await Promise.all([
    prisma.book.count({ where: { hidden: false } }),
    prisma.book.count({ where: { hidden: false, format: 'COMIC' } }),
    prisma.book.count({ where: { hidden: false, format: 'EPUB' } }),
    prisma.book.aggregate({ where: { hidden: false }, _sum: { sizeBytes: true } }),
    prisma.monitorFolder.count({ where: { enabled: true } }),
    prisma.importTask.findFirst({ where: { status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, updatedAt: true } }),
    prisma.readingProgress.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } })
  ]);

  return ok({
    totalBooks,
    comicBooks,
    novelBooks,
    storageUsedBytes: Number(storage._sum.sizeBytes ?? BigInt(0)),
    monitorFolderCount,
    lastImportAt: lastImport?.finishedAt ?? lastImport?.updatedAt ?? null,
    latestSyncAt: latestProgress?.updatedAt ?? null
  });
}

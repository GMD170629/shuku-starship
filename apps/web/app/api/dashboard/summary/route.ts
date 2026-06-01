import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET() {
  await requireUser();
  const [totalBooks, comicBooks, novelBooks, storage, monitorFolderCount, lastImport, latestProgress] = await Promise.all([
    prisma.libraryWork.count({ where: { hidden: false } }),
    prisma.libraryWork.count({ where: { hidden: false, workType: 'COMIC' } }),
    prisma.libraryWork.count({ where: { hidden: false, workType: 'EPUB' } }),
    prisma.libraryEdition.aggregate({ where: { hidden: false, work: { hidden: false } }, _sum: { sizeBytes: true } }),
    prisma.monitorFolder.count({ where: { enabled: true } }),
    prisma.importTask.findFirst({ where: { status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, updatedAt: true } }),
    prisma.libraryReadingProgress.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } })
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

import { ensureComicVolumePageIndex } from '@shuku/scanner/managed-import';
import { requireUser } from '../../../../../lib/auth';
import { toWorkView } from '../../../../../lib/books';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { getAllReaderPreferenceSettings } from '../../../../../lib/reader-preferences';

function safeJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeProgress(progress: { extra: string } & Record<string, unknown> | null | undefined) {
  if (!progress) return null;
  return { ...progress, extra: safeJson(progress.extra) };
}

export async function GET(request: Request, { params }: { params: { editionId: string } }) {
  const user = await requireUser();
  const userId = user.id;
  const url = new URL(request.url);
  const requestedVolumeId = url.searchParams.get('volume') ?? url.searchParams.get('section');
  const edition = await prisma.libraryEdition.findFirst({
    where: { id: params.editionId, hidden: false, work: { hidden: false } },
    include: {
      work: {
        include: {
          editions: {
            where: { hidden: false },
            include: {
              files: { orderBy: { sortOrder: 'asc' } },
              volumes: { orderBy: { sortOrder: 'asc' } },
              progresses: { where: { userId }, take: 1 }
            }
          }
        }
      },
      files: { orderBy: { sortOrder: 'asc' } },
      volumes: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { orderBy: { sortOrder: 'asc' } },
      progresses: { where: { userId }, take: 1 }
    }
  });
  if (!edition) return fail('读物版本不存在或无权访问', 404);

  const readerType = edition.format === 'COMIC' ? 'comic' : edition.format === 'EPUB' ? 'ebook' : 'unknown';
  const preferences = await getAllReaderPreferenceSettings(user.id);
  const progress = serializeProgress(edition.progresses[0] ?? null);
  const workView = toWorkView({ ...edition.work, editions: edition.work.editions });

  if (readerType === 'ebook') {
    const readingUnits = edition.readingUnits.map((unit) => ({
      ...unit,
      size: unit.size ? Number(unit.size) : null,
      metadataJson: safeJson(unit.metadataJson)
    }));
    return ok({ book: { ...workView, editionId: edition.id, formatValue: edition.format }, readerType, progress, preferences, readingUnits, totalUnits: readingUnits.length });
  }

  if (readerType === 'comic') {
    const volume = requestedVolumeId
      ? edition.volumes.find((item) => item.id === requestedVolumeId) ?? edition.volumes[0] ?? null
      : edition.volumes[0] ?? null;
    let pageUnits = edition.readingUnits.filter((unit) => !volume || unit.volumeId === volume.id);
    if (volume && pageUnits.length === 0) {
      await ensureComicVolumePageIndex(volume.id);
      const indexedUnits = await prisma.libraryReadingUnit.findMany({ where: { volumeId: volume.id, unitType: 'page' }, orderBy: { sortOrder: 'asc' } });
      pageUnits = indexedUnits;
    }
    return ok({
      book: { ...workView, editionId: edition.id, formatValue: edition.format },
      readerType,
      progress,
      preferences,
      section: volume ? { id: volume.id, title: volume.title, pageCount: pageUnits.length } : null,
      sections: edition.volumes.map((item) => ({ id: item.id, title: item.title, pageCount: item.pageCount ?? 0 })),
      pageCount: pageUnits.length,
      pages: pageUnits.map((page, index) => ({
        pageIndex: index + 1,
        title: page.title,
        mimeType: page.mediaType,
        width: page.width,
        height: page.height,
        size: page.size ? Number(page.size) : null
      }))
    });
  }

  return ok({ book: workView, readerType, progress, preferences });
}

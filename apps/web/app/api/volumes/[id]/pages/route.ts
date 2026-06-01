import { ensureComicVolumePageIndex } from '@shuku/scanner/managed-import';
import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const visibleVolume = await prisma.libraryVolume.findFirst({
    where: { id: params.id, edition: { hidden: false, work: { hidden: false } } },
    select: { id: true }
  });
  if (!visibleVolume) return fail('漫画卷不存在或无权访问', 404);
  try {
    await ensureComicVolumePageIndex(params.id);
  } catch (error) {
    console.error('[library-volume-page-index-error]', { volumeId: params.id, error });
    return fail('漫画页索引建立失败', 500);
  }
  const volume = await prisma.libraryVolume.findFirst({
    where: { id: params.id, edition: { hidden: false, work: { hidden: false } } },
    include: { readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' } } }
  });
  if (!volume) return fail('漫画卷不存在或无权访问', 404);
  return ok({
    volume: { id: volume.id, title: volume.title, pageCount: volume.readingUnits.length },
    pageCount: volume.readingUnits.length,
    pages: volume.readingUnits.map((page, index) => ({
      pageIndex: index + 1,
      title: page.title,
      mimeType: page.mediaType,
      width: page.width,
      height: page.height,
      size: page.size ? Number(page.size) : null
    }))
  });
}

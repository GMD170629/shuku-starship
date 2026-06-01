import { Readable } from 'node:stream';
import { ensureComicVolumePageIndex } from '@shuku/scanner/managed-import';
import { requireUser } from '../../../../../../lib/auth';
import { closeComicArchive, streamComicPageFromArchive } from '../../../../../../lib/comic-import';
import { fail } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';
import { requireReadableFilePath } from '../../../../../../lib/storage-path';

export async function GET(_request: Request, { params }: { params: { id: string; pageIndex: string } }) {
  await requireUser();
  const pageIndex = Number(params.pageIndex);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) return fail('页面编号不正确', 400);
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
    include: {
      readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' }, include: { file: true } }
    }
  });
  if (!volume) return fail('漫画卷不存在或无权访问', 404);
  const unit = volume.readingUnits[pageIndex - 1];
  if (!unit?.file) return fail('图片页面不存在', 404);
  try {
    const archive = await requireReadableFilePath(unit.file.path, '漫画文件不可读');
    const page = await streamComicPageFromArchive(archive.path, unit.href);
    const close = () => closeComicArchive(page.zipFile);
    page.stream.once('close', close);
    page.stream.once('end', close);
    page.stream.once('error', close);
    return new Response(Readable.toWeb(page.stream) as ReadableStream, {
      headers: {
        'Content-Type': page.mediaType,
        'Content-Length': String(page.size),
        'Cache-Control': 'private, max-age=86400'
      }
    });
  } catch (error) {
    console.error('[library-volume-page-error]', { volumeId: volume.id, pageIndex, error });
    return fail('漫画页面读取失败', 500);
  }
}

import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { requireUser } from '../../../../../../lib/auth';
import { ensureArchiveIndex, streamArchivePageResponse } from '../../../../../../lib/archive-index';
import { closeComicArchive, streamComicPageFromArchive } from '../../../../../../lib/comic-import';
import { fail } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';
import { buildComicSections, selectComicSection, unitsForComicSection } from '../../../../../../lib/comic-sections';
import { requireReadableFilePath } from '../../../../../../lib/storage-path';

const archiveExts = new Set(['.cbz', '.zip']);

function isArchiveFile(path: string, mimeType: string) {
  const ext = extname(path).toLowerCase();
  return archiveExts.has(ext) || mimeType === 'application/vnd.comicbook+zip' || mimeType === 'application/zip';
}

export async function GET(request: Request, { params }: { params: { id: string; pageIndex: string } }) {
  const user = await requireUser();
  const pageIndex = Number(params.pageIndex);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) return fail('页面编号不正确', 400);

  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);

  const archiveFile = book.files.length === 1 && isArchiveFile(book.files[0].path, book.files[0].mimeType) ? book.files[0] : null;
  if (book.readingUnits.length > 0) {
    const url = new URL(request.url);
    const sections = buildComicSections(book.id, book.files, book.readingUnits);
    const section = selectComicSection(sections, url.searchParams);
    const sectionUnits = section ? unitsForComicSection(section, book.readingUnits) : book.readingUnits;
    const unit = sectionUnits[pageIndex - 1] ?? null;
    if (!unit) return fail('图片页面不存在', 404);
    const pageFile = unit.filePath
      ? book.files.find((file) => file.path === unit.filePath && isArchiveFile(file.path, file.mimeType))
      : archiveFile;
    if (!pageFile) return fail('漫画页面所属文件不可读', 404);
    try {
      const archive = await requireReadableFilePath(pageFile.path, '漫画文件不可读');
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
      console.error('[comic-reading-unit-page-error]', { bookId: book.id, pageIndex, error });
      return fail('漫画页面读取失败', 500);
    }
  }

  if (!archiveFile) {
    return fail('读物没有漫画页面', 400);
  }

  let realPath: string;
  try {
    realPath = (await requireReadableFilePath(archiveFile.path, '漫画文件不可读')).path;
  } catch (error) {
    return fail('漫画文件不可读', 404);
  }

  try {
    const index = await ensureArchiveIndex(book.id, archiveFile.id, realPath);
    return streamArchivePageResponse({
      request,
      userId: user.id,
      bookId: book.id,
      fileId: archiveFile.id,
      path: realPath,
      index,
      pageIndex
    });
  } catch (error) {
    console.error('[archive-page-error]', { bookId: book.id, fileId: archiveFile.id, pageIndex, error });
    return fail('漫画页面读取失败', 500);
  }
}

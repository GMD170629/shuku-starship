import { extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { PathSecurityError } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../../../../lib/auth';
import { ensureArchiveIndex, streamArchivePageResponse } from '../../../../../../lib/archive-index';
import { closeComicArchive, streamComicPageFromArchive } from '../../../../../../lib/comic-import';
import { FileAccessService, fileSecurityStatus } from '../../../../../../lib/file-access-service';
import { mimeTypeForPath, streamFileResponse } from '../../../../../../lib/file-response';
import { fail } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';

const archiveExts = new Set(['.cbz', '.zip']);

function isArchiveFile(path: string, mimeType: string) {
  const ext = extname(path).toLowerCase();
  return archiveExts.has(ext) || mimeType === 'application/vnd.comicbook+zip' || mimeType === 'application/zip';
}

async function readableArchivePath(path: string, libraryRoot?: string | null) {
  if (libraryRoot) return (await new FileAccessService().validateReadableFile(path, libraryRoot)).realPath;
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error('漫画文件不可读');
  return path;
}

export async function GET(request: Request, { params }: { params: { id: string; pageIndex: string } }) {
  const user = await requireUser();
  const pageIndex = Number(params.pageIndex);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) return fail('页面编号不正确', 400);

  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: {
      libraryPath: true,
      files: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);

  const archiveFile = book.files.length === 1 && isArchiveFile(book.files[0].path, book.files[0].mimeType) ? book.files[0] : null;
  if (archiveFile && book.readingUnits.length > 0) {
    const unit = book.readingUnits.find((item) => item.sortOrder === pageIndex);
    if (!unit) return fail('图片页面不存在', 404);
    try {
      const realPath = await readableArchivePath(archiveFile.path, book.libraryPath?.rootPath);
      const page = await streamComicPageFromArchive(realPath, unit.href);
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
      if (error instanceof PathSecurityError) return fail(error.message, fileSecurityStatus(error));
      console.error('[comic-reading-unit-page-error]', { bookId: book.id, pageIndex, error });
      return fail('漫画页面读取失败', 500);
    }
  }

  if (book.libraryPath && !book.libraryPath.enabled) return fail('读物不存在或无权访问', 404);
  if (!archiveFile) {
    const imageFiles = book.files.filter((file) => file.kind === 'IMAGE' || file.mimeType.startsWith('image/'));
    const file = imageFiles[pageIndex - 1];
    if (!file) return fail('图片页面不存在', 404);
    try {
      if (!book.libraryPath?.rootPath) return fail('图片页面不可读', 404);
      const validation = await new FileAccessService().validateReadableFile(file.path, book.libraryPath.rootPath);
      const fileStat = await stat(validation.realPath).catch(() => null);
      if (!fileStat?.isFile()) return fail('图片页面不可读', 404);
      return streamFileResponse({
        request,
        userId: user.id,
        route: '/api/books/[id]/pages/[pageIndex]',
        bookId: book.id,
        fileId: file.id,
        path: validation.realPath,
        stat: fileStat,
        mimeType: file.mimeType || mimeTypeForPath(validation.realPath),
        downloadName: validation.realPath.split('/').at(-1) ?? 'page'
      });
    } catch (error) {
      if (error instanceof PathSecurityError) return fail(error.message, fileSecurityStatus(error));
      throw error;
    }
  }

  let realPath: string;
  try {
    realPath = await readableArchivePath(archiveFile.path, book.libraryPath?.rootPath);
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, fileSecurityStatus(error));
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

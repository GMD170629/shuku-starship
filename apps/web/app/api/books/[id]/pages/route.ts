import { extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { PathSecurityError } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../../../lib/auth';
import { ensureArchiveIndex } from '../../../../../lib/archive-index';
import { FileAccessService, fileSecurityStatus } from '../../../../../lib/file-access-service';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

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

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: {
      libraryPath: true,
      files: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);

  if (book.readingUnits.length > 0) {
    return ok({
      pageCount: book.readingUnits.length,
      pages: book.readingUnits.map((page) => ({
        pageIndex: page.sortOrder,
        title: page.title,
        mimeType: page.mediaType,
        width: page.width,
        height: page.height,
        size: page.size ? Number(page.size) : null
      }))
    });
  }

  if (book.libraryPath && !book.libraryPath.enabled) return fail('读物不存在或无权访问', 404);
  const archiveFile = book.files.length === 1 && isArchiveFile(book.files[0].path, book.files[0].mimeType) ? book.files[0] : null;
  if (!archiveFile) {
    const imageFiles = book.files.filter((file) => file.kind === 'IMAGE' || file.mimeType.startsWith('image/'));
    if (imageFiles.length === 0) return fail('读物没有图片页面', 400);
    return ok({
      pageCount: imageFiles.length,
      pages: imageFiles.map((page, index) => ({
        pageIndex: index + 1,
        mimeType: page.mimeType
      }))
    });
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
    return ok({
      pageCount: index.pages.length,
      pages: index.pages.map((page) => ({
        pageIndex: page.pageIndex,
        mimeType: page.mimeType
      }))
    });
  } catch (error) {
    console.error('[archive-index-error]', { bookId: book.id, fileId: archiveFile.id, error });
    return fail('漫画索引生成失败', 500);
  }
}

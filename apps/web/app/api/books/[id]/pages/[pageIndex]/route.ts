import { extname } from 'node:path';
import { PathSecurityError } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../../../../lib/auth';
import { ensureArchiveIndex, streamArchivePageResponse } from '../../../../../../lib/archive-index';
import { FileAccessService, fileSecurityStatus } from '../../../../../../lib/file-access-service';
import { fail } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';

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
      libraryPath: true,
      files: { orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book || !book.libraryPath?.enabled) return fail('读物不存在或无权访问', 404);

  const archiveFile = book.files.length === 1 && isArchiveFile(book.files[0].path, book.files[0].mimeType) ? book.files[0] : null;
  if (!archiveFile) return fail('读物不是单文件漫画压缩包', 400);

  let validation;
  try {
    validation = await new FileAccessService().validateReadableFile(archiveFile.path, book.libraryPath.rootPath);
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, fileSecurityStatus(error));
    throw error;
  }

  try {
    const index = await ensureArchiveIndex(book.id, archiveFile.id, validation.realPath);
    return streamArchivePageResponse({
      request,
      userId: user.id,
      bookId: book.id,
      fileId: archiveFile.id,
      path: validation.realPath,
      index,
      pageIndex
    });
  } catch (error) {
    console.error('[archive-page-error]', { bookId: book.id, fileId: archiveFile.id, pageIndex, error });
    return fail('漫画页面读取失败', 500);
  }
}

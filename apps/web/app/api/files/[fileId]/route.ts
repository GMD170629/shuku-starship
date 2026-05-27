import { stat } from 'node:fs/promises';
import { PathSecurityError } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../../lib/auth';
import { FileAccessService, fileSecurityStatus } from '../../../../lib/file-access-service';
import { mimeTypeForPath, streamFileResponse } from '../../../../lib/file-response';
import { fail } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET(request: Request, { params }: { params: { fileId: string } }) {
  const user = await requireUser();
  const file = await prisma.bookFile.findUnique({
    where: { id: params.fileId },
    include: { book: { include: { libraryPath: true } } }
  });
  if (!file || file.book.hidden || !file.book.libraryPath?.enabled) return fail('文件不存在或无权访问', 404);
  let validation;
  try {
    validation = await new FileAccessService().validateReadableFile(file.path, file.book.libraryPath.rootPath);
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, fileSecurityStatus(error));
    throw error;
  }

  const fileStat = await stat(validation.realPath).catch(() => null);
  if (!fileStat?.isFile()) return fail('文件不可读', 404);

  return streamFileResponse({
    request,
    userId: user.id,
    route: '/api/files/[fileId]',
    bookId: file.bookId,
    fileId: file.id,
    path: validation.realPath,
    stat: fileStat,
    mimeType: file.mimeType || mimeTypeForPath(validation.realPath),
    downloadName: validation.realPath.split('/').at(-1) ?? 'file'
  });
}

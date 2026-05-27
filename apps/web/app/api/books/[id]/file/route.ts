import { stat } from 'node:fs/promises';
import { PathSecurityError } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../../../lib/auth';
import { FileAccessService, fileSecurityStatus } from '../../../../../lib/file-access-service';
import { mimeTypeForPath, streamFileResponse } from '../../../../../lib/file-response';
import { fail } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: { libraryPath: true, files: { orderBy: { sortOrder: 'asc' } } }
  });
  if (!book || !book.libraryPath?.enabled) return fail('读物不存在或无权访问', 404);
  const file = book.files[0];
  if (!file) return fail('读物没有可读取的文件', 404);

  try {
    const validation = await new FileAccessService().validateReadableFile(file.path, book.libraryPath.rootPath);
    const fileStat = await stat(validation.realPath).catch(() => null);
    if (!fileStat?.isFile()) return fail('文件不存在或不可读', 404);
    return streamFileResponse({
      request,
      userId: user.id,
      route: '/api/books/[id]/file',
      bookId: book.id,
      fileId: file.id,
      path: validation.realPath,
      stat: fileStat,
      mimeType: file.mimeType || mimeTypeForPath(validation.realPath),
      downloadName: validation.realPath.split('/').at(-1) ?? 'file'
    });
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, fileSecurityStatus(error));
    return fail('文件不存在、无权限或格式不支持', 500, String(error));
  }
}

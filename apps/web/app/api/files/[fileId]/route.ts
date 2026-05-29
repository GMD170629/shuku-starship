import { stat } from 'node:fs/promises';
import { requireUser } from '../../../../lib/auth';
import { mimeTypeForPath, streamFileResponse } from '../../../../lib/file-response';
import { fail } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function GET(request: Request, { params }: { params: { fileId: string } }) {
  const user = await requireUser();
  const file = await prisma.bookFile.findUnique({
    where: { id: params.fileId },
    include: { book: true }
  });
  if (!file || file.book.hidden) return fail('文件不存在或无权访问', 404);

  const fileStat = await stat(file.path).catch(() => null);
  if (!fileStat?.isFile()) return fail('文件不可读', 404);

  return streamFileResponse({
    request,
    userId: user.id,
    route: '/api/files/[fileId]',
    bookId: file.bookId,
    fileId: file.id,
    path: file.path,
    stat: fileStat,
    mimeType: file.mimeType || mimeTypeForPath(file.path),
    downloadName: file.path.split('/').at(-1) ?? 'file'
  });
}

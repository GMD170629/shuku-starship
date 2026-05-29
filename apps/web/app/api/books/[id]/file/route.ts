import { stat } from 'node:fs/promises';
import { requireUser } from '../../../../../lib/auth';
import { mimeTypeForPath, streamFileResponse } from '../../../../../lib/file-response';
import { fail } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: { files: { orderBy: { sortOrder: 'asc' } } }
  });
  if (!book) return fail('读物不存在或无权访问', 404);
  const file = book.files[0];
  if (!file) return fail('读物没有可读取的文件', 404);

  const fileStat = await stat(file.path).catch(() => null);
  if (!fileStat?.isFile()) return fail('文件不存在或不可读', 404);
  return streamFileResponse({
    request,
    userId: user.id,
    route: '/api/books/[id]/file',
    bookId: book.id,
    fileId: file.id,
    path: file.path,
    stat: fileStat,
    mimeType: file.mimeType || mimeTypeForPath(file.path),
    downloadName: file.path.split('/').at(-1) ?? 'file'
  });
}

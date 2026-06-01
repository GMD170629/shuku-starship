import { requireUser } from '../../../../lib/auth';
import { mimeTypeForPath, streamFileResponse } from '../../../../lib/file-response';
import { fail } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';
import { readableFilePath } from '../../../../lib/storage-path';

export async function GET(request: Request, { params }: { params: { fileId: string } }) {
  const user = await requireUser();
  const file = await prisma.libraryFile.findUnique({
    where: { id: params.fileId },
    include: { edition: { include: { work: true } } }
  });
  if (!file || file.edition.hidden || file.edition.work.hidden) return fail('文件不存在或无权访问', 404);

  const readable = await readableFilePath(file.path);
  if (!readable) return fail('文件不可读', 404);

  return streamFileResponse({
    request,
    userId: user.id,
    route: '/api/files/[fileId]',
    bookId: file.edition.workId,
    fileId: file.id,
    path: readable.path,
    stat: readable.stat,
    mimeType: file.mimeType || mimeTypeForPath(file.path),
    downloadName: file.path.split('/').at(-1) ?? 'file'
  });
}

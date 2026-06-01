import { requireUser } from '../../../../../lib/auth';
import { streamFileResponse } from '../../../../../lib/file-response';
import { fail } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { readableFilePath } from '../../../../../lib/storage-path';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const edition = await prisma.libraryEdition.findFirst({
    where: { id: params.id, hidden: false, work: { hidden: false } },
    include: { files: { orderBy: { sortOrder: 'asc' } }, work: true }
  });
  if (!edition) return fail('读物版本不存在或无权访问', 404);
  const file = edition.files[0];
  if (!file) return fail('版本没有可读文件', 404);
  const readable = await readableFilePath(file.path);
  if (!readable) return fail('文件不存在或不可读', 404);
  return streamFileResponse({
    request,
    userId: user.id,
    route: '/api/editions/[id]/file',
    bookId: edition.workId,
    fileId: file.id,
    path: readable.path,
    stat: readable.stat,
    mimeType: file.mimeType,
    downloadName: `${edition.work.title}.${edition.format === 'EPUB' ? 'epub' : 'zip'}`
  });
}

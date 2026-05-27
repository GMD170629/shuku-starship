import { readFile } from 'node:fs/promises';
import { PathSecurityError } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../../../lib/auth';
import { FileAccessService, fileSecurityStatus } from '../../../../../lib/file-access-service';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: { libraryPath: true, files: { orderBy: { sortOrder: 'asc' } } }
  });
  if (!book || !book.libraryPath?.enabled) return fail('读物不存在或无权访问', 404);
  if (!['TXT', 'EPUB'].includes(book.format)) return fail('该读物不是文本内容', 400);
  const file = book.files.find((item) => item.kind === 'TXT') ?? book.files[0];
  if (!file) return fail('读物没有可读取的文件', 404);

  try {
    const validation = await new FileAccessService().validateReadableFile(file.path, book.libraryPath.rootPath);
    const content = await readFile(validation.realPath, 'utf8');
    return ok({ content });
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, fileSecurityStatus(error));
    return fail('文件不存在、无权限或格式不支持', 500, String(error));
  }
}

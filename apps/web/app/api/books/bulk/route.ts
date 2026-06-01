import type { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { mergeTags, parseReadingStatus } from '../../../../lib/book-metadata';
import { parseTags } from '../../../../lib/books';
import { prisma } from '../../../../lib/prisma';

type BulkBody = {
  ids?: string[];
  format?: string;
  status?: string;
  addTags?: string[];
  removeTags?: string[];
  ignored?: boolean;
  regenerateCover?: boolean;
  deleteRecords?: boolean;
  markOrganized?: boolean;
};

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<BulkBody>(request);
  const ids = [...new Set((body.ids ?? []).map(String).filter(Boolean))];
  if (ids.length === 0) return fail('请选择要批量处理的读物', 400);
  if (ids.length > 200) return fail('单次最多批量处理 200 本读物', 400);
  if (body.deleteRecords) {
    const result = await prisma.libraryWork.deleteMany({ where: { id: { in: ids } } });
    return ok({ matched: ids.length, deleted: result.count, sourceFilesDeleted: false });
  }

  const data: Prisma.LibraryWorkUpdateInput = {};
  if (typeof body.status === 'string') {
    const status = parseReadingStatus(body.status);
    if (!status) return fail('阅读状态不正确', 400);
    data.status = status;
  }
  if (typeof body.ignored === 'boolean') data.hidden = body.ignored;
  if (typeof body.markOrganized === 'boolean') data.organized = body.markOrganized;

  const hasBulkData = Object.keys(data).length > 0;
  const hasTagChange = Array.isArray(body.addTags) || Array.isArray(body.removeTags);

  const updated = await prisma.$transaction(async (tx) => {
    let count = 0;
    if (hasBulkData) {
      const result = await tx.libraryWork.updateMany({ where: { id: { in: ids } }, data });
      count = result.count;
    }
    if (hasTagChange) {
      const books = await tx.libraryWork.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
      await Promise.all(
        books.map((book) =>
          tx.libraryWork.update({
            where: { id: book.id },
            data: { tags: JSON.stringify(mergeTags(parseTags(book.tags), body.addTags, body.removeTags)) }
          })
        )
      );
      count = Math.max(count, books.length);
    }
    return count;
  });

  let coverSucceeded = 0;
  let coverFailed = 0;
  if (body.regenerateCover) {
    coverFailed = ids.length;
  }

  return ok({
    matched: ids.length,
    updated,
    covers: {
      requested: Boolean(body.regenerateCover),
      succeeded: coverSucceeded,
      failed: coverFailed
    }
  });
}

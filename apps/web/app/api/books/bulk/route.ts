import { CoverService } from '@shuku/scanner/cover-service';
import type { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { mergeTags, parseReadingFormat, parseReadingStatus } from '../../../../lib/book-metadata';
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
};

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<BulkBody>(request);
  const ids = [...new Set((body.ids ?? []).map(String).filter(Boolean))];
  if (ids.length === 0) return fail('请选择要批量处理的读物', 400);
  if (ids.length > 200) return fail('单次最多批量处理 200 本读物', 400);

  const data: Prisma.BookUpdateInput = {};
  if (typeof body.format === 'string') {
    const format = parseReadingFormat(body.format);
    if (!format) return fail('读物类型不正确', 400);
    data.format = format;
  }
  if (typeof body.status === 'string') {
    const status = parseReadingStatus(body.status);
    if (!status) return fail('阅读状态不正确', 400);
    data.status = status;
  }
  if (typeof body.ignored === 'boolean') data.hidden = body.ignored;

  const hasBulkData = Object.keys(data).length > 0;
  const hasTagChange = Array.isArray(body.addTags) || Array.isArray(body.removeTags);

  const updated = await prisma.$transaction(async (tx) => {
    let count = 0;
    if (hasBulkData) {
      const result = await tx.book.updateMany({ where: { id: { in: ids } }, data });
      count = result.count;
    }
    if (hasTagChange) {
      const books = await tx.book.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
      await Promise.all(
        books.map((book) =>
          tx.book.update({
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
    const books = await prisma.book.findMany({
      where: { id: { in: ids } },
      include: { files: { orderBy: { sortOrder: 'asc' } } }
    });
    for (const book of books) {
      try {
        await CoverService.generateBookCover(book);
        coverSucceeded += 1;
      } catch {
        coverFailed += 1;
      }
    }
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

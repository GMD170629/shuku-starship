import type { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { toBookView } from '../../../../lib/books';
import { prisma } from '../../../../lib/prisma';
import { normalizeTags, parseReadingFormat, parseReadingStatus } from '../../../../lib/book-metadata';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const book = await prisma.book.findFirst({
    where: { id: params.id },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      monitorFolder: true,
      progresses: { where: { userId: user.id }, take: 1 },
      chapters: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { orderBy: { sortOrder: 'asc' } },
      metadataItems: { orderBy: { createdAt: 'desc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);
  const metadataItems = book.metadataItems.map((item) => ({ id: item.id, source: item.source, metadataJson: safeJson(item.rawJson), createdAt: item.createdAt }));
  return ok({
    book: toBookView(book),
    metadata: {
      language: book.language,
      publisher: book.publisher,
      publishedAt: book.publishedAt,
      identifier: book.identifier,
      isbn: book.isbn,
      importStatus: book.importStatus,
      importError: book.importError,
      items: metadataItems
    },
    totalUnits: book.format === 'COMIC' ? (book.pageCount ?? book.readingUnits.length) : (book.chapterCount ?? book.readingUnits.length),
    chapters: book.chapters,
    readingUnits: book.readingUnits.length ? book.readingUnits.map(serializeReadingUnit) : book.chapters.map((chapter) => ({ ...chapter, unitType: 'chapter' }))
  });
}

function serializeReadingUnit(unit: { size?: bigint | null; metadataJson?: string } & Record<string, unknown>) {
  return { ...unit, size: unit.size ? Number(unit.size) : null, metadataJson: unit.metadataJson ? safeJson(unit.metadataJson) : {} };
}

function safeJson(value: string) {
  try { return JSON.parse(value); } catch { return value; }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const body = await readJson<{
    title?: string;
    author?: string;
    description?: string;
    format?: string;
    tags?: string[];
    status?: string;
    ignored?: boolean;
    coverPath?: string;
  }>(request);
  const data: Prisma.BookUpdateInput = {};
  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (!title) return fail('标题不能为空', 400);
    data.title = title;
  }
  if (typeof body.author === 'string') data.author = body.author.trim() || null;
  if (typeof body.description === 'string') data.description = body.description;
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
  if (Array.isArray(body.tags)) data.tags = JSON.stringify(normalizeTags(body.tags));
  if (typeof body.ignored === 'boolean') data.hidden = body.ignored;
  if (typeof body.coverPath === 'string') data.coverPath = body.coverPath;
  await prisma.book.update({ where: { id: params.id }, data });
  const book = await prisma.book.findUnique({
    where: { id: params.id },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      monitorFolder: true,
      progresses: { where: { userId: user.id }, take: 1 },
      chapters: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { orderBy: { sortOrder: 'asc' } },
      metadataItems: { orderBy: { createdAt: 'desc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);
  return ok({ book: toBookView(book) });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  await prisma.book.update({ where: { id: params.id }, data: { hidden: true } });
  return ok({ ignored: true });
}

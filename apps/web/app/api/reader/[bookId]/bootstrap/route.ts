import { extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { requireUser } from '../../../../../lib/auth';
import { ensureArchiveIndex } from '../../../../../lib/archive-index';
import { toBookView } from '../../../../../lib/books';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { getAllReaderPreferenceSettings } from '../../../../../lib/reader-preferences';

const archiveExts = new Set(['.cbz', '.zip']);

function isArchiveFile(path: string, mimeType: string) {
  const ext = extname(path).toLowerCase();
  return archiveExts.has(ext) || mimeType === 'application/vnd.comicbook+zip' || mimeType === 'application/zip';
}

async function readableArchivePath(path: string) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error('漫画文件不可读');
  return path;
}

function safeJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeReadingUnit(unit: { size?: bigint | null; metadataJson?: string } & Record<string, unknown>) {
  return { ...unit, size: unit.size ? Number(unit.size) : null, metadataJson: unit.metadataJson ? safeJson(unit.metadataJson) : {} };
}

function serializeProgress(progress: { extra: string } & Record<string, unknown> | null | undefined) {
  if (!progress) return null;
  return { ...progress, extra: safeJson(progress.extra) };
}

export async function GET(_request: Request, { params }: { params: { bookId: string } }) {
  const user = await requireUser();
  const book = await prisma.book.findFirst({
    where: { id: params.bookId, hidden: false },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      progresses: { where: { userId: user.id }, take: 1 },
      chapters: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);

  const readerType = book.format === 'COMIC' ? 'comic' : book.format === 'EPUB' ? 'ebook' : 'unknown';
  const preferences = await getAllReaderPreferenceSettings(user.id);
  const progress = serializeProgress(book.progresses[0] ?? null);

  if (readerType === 'ebook') {
    const readingUnits = book.readingUnits.length
      ? book.readingUnits.map(serializeReadingUnit)
      : book.chapters.map((chapter) => ({
          id: chapter.id,
          bookId: chapter.bookId,
          unitType: 'chapter',
          title: chapter.title,
          href: chapter.href,
          filePath: null,
          mediaType: chapter.mediaType,
          sortOrder: chapter.sortOrder,
          width: null,
          height: null,
          size: null,
          metadataJson: {},
          createdAt: chapter.createdAt,
          updatedAt: chapter.updatedAt
        }));
    return ok({ book: toBookView(book), readerType, progress, preferences, readingUnits, totalUnits: readingUnits.length });
  }

  if (readerType === 'comic') {
    const pageUnits = book.readingUnits.filter((unit) => unit.unitType === 'page').sort((left, right) => left.sortOrder - right.sortOrder);
    if (pageUnits.length > 0) {
      return ok({
        book: toBookView(book),
        readerType,
        progress,
        preferences,
        pageCount: pageUnits.length,
        pages: pageUnits.map((page) => ({
          pageIndex: page.sortOrder,
          title: page.title,
          mimeType: page.mediaType,
          width: page.width,
          height: page.height,
          size: page.size ? Number(page.size) : null
        }))
      });
    }

    const archiveFile = book.files.length === 1 && isArchiveFile(book.files[0].path, book.files[0].mimeType) ? book.files[0] : null;
    if (!archiveFile) {
      return ok({ book: toBookView(book), readerType, progress, preferences, pageCount: 0, pages: [] });
    }

    let realPath: string;
    try {
      realPath = await readableArchivePath(archiveFile.path);
    } catch {
      return fail('漫画文件不可读', 404);
    }

    try {
      const index = await ensureArchiveIndex(book.id, archiveFile.id, realPath);
      return ok({
        book: toBookView(book),
        readerType,
        progress,
        preferences,
        pageCount: index.pages.length,
        pages: index.pages.map((page) => ({ pageIndex: page.pageIndex, mimeType: page.mimeType }))
      });
    } catch (error) {
      console.error('[reader-bootstrap-archive-index-error]', { bookId: book.id, fileId: archiveFile.id, error });
      return fail('漫画索引生成失败', 500);
    }
  }

  return ok({ book: toBookView(book), readerType, progress, preferences });
}

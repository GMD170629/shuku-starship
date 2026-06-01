import { extname } from 'node:path';
import { requireUser } from '../../../../../lib/auth';
import { ensureArchiveIndex } from '../../../../../lib/archive-index';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { buildComicSections, selectComicSection, unitsForComicSection } from '../../../../../lib/comic-sections';
import { requireReadableFilePath } from '../../../../../lib/storage-path';

const archiveExts = new Set(['.cbz', '.zip']);

function isArchiveFile(path: string, mimeType: string) {
  const ext = extname(path).toLowerCase();
  return archiveExts.has(ext) || mimeType === 'application/vnd.comicbook+zip' || mimeType === 'application/zip';
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const url = new URL(request.url);
  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book) return fail('读物不存在或无权访问', 404);

  if (book.readingUnits.length > 0) {
    const sections = buildComicSections(book.id, book.files, book.readingUnits);
    const section = selectComicSection(sections, url.searchParams);
    const sectionUnits = section ? unitsForComicSection(section, book.readingUnits) : book.readingUnits;
    return ok({
      section,
      sections,
      pageCount: sectionUnits.length,
      pages: sectionUnits.map((page, index) => ({
        pageIndex: index + 1,
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
    return fail('读物没有漫画页面', 400);
  }

  let realPath: string;
  try {
    realPath = (await requireReadableFilePath(archiveFile.path, '漫画文件不可读')).path;
  } catch (error) {
    return fail('漫画文件不可读', 404);
  }

  try {
    const index = await ensureArchiveIndex(book.id, archiveFile.id, realPath);
    return ok({
      pageCount: index.pages.length,
      pages: index.pages.map((page) => ({
        pageIndex: page.pageIndex,
        mimeType: page.mimeType
      }))
    });
  } catch (error) {
    console.error('[archive-index-error]', { bookId: book.id, fileId: archiveFile.id, error });
    return fail('漫画索引生成失败', 500);
  }
}

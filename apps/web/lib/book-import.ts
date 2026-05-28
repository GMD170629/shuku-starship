import { extname } from 'node:path';
import { importComicArchive, type ImportComicResult } from './comic-import';
import { importEpubBook } from './epub-import';

export type ImportBookOptions = {
  filePath: string;
  originalName?: string;
  libraryPathId?: string;
};

export type UnifiedImportBookResult =
  | {
      bookId: string;
      title: string;
      type: 'ebook';
      format: 'epub';
      totalUnits: number;
      coverUrl?: string | null;
      importStatus: 'completed' | 'failed';
    }
  | ImportComicResult;

export async function importBook(options: ImportBookOptions): Promise<UnifiedImportBookResult> {
  const ext = extname(options.originalName || options.filePath).toLowerCase();
  if (ext === '.epub') {
    const result = await importEpubBook(options.filePath);
    return {
      bookId: result.bookId,
      title: result.title,
      type: 'ebook',
      format: 'epub',
      totalUnits: result.chapterCount,
      coverUrl: result.coverUrl,
      importStatus: result.importStatus
    };
  }
  if (ext === '.cbz' || ext === '.zip') return importComicArchive(options);
  throw new Error('当前版本仅支持 EPUB、CBZ、ZIP 格式。');
}

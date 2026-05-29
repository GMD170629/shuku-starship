import { importManagedBook, parseEpubMetadata } from '@shuku/scanner/managed-import';

export { parseEpubMetadata };

export async function importEpubBook(filePath: string) {
  const result = await importManagedBook({ sourceFilePath: filePath, origin: 'MANUAL' });
  return {
    bookId: result.bookId,
    title: result.title,
    chapterCount: result.totalUnits,
    coverUrl: result.coverUrl ?? null,
    importStatus: result.importStatus
  };
}

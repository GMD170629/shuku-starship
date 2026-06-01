import { basename } from 'node:path';
import type { BookFile, ReadingUnit } from '@prisma/client';

export type ComicSection = {
  id: string;
  title: string;
  index: number;
  fileId: string;
  filePath: string;
  pageCount: number;
  firstPage: number;
  coverUrl: string;
  prefix?: string | null;
};

type PageUnit = ReadingUnit & { metadataJson: string };
type ComicFile = Pick<BookFile, 'id' | 'path' | 'sortOrder'>;

export function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function compactTitle(value: string) {
  return value.replaceAll('_', ' ').replaceAll('-', ' ').replace(/\s+/g, ' ').trim();
}

function volumeTitle(index: number | null | undefined, fallback: string) {
  return Number.isFinite(index) ? `第 ${index} 卷` : compactTitle(basename(fallback, fallback.split('.').at(-1) ? `.${fallback.split('.').at(-1)}` : undefined)) || '正文';
}

function topLevelPrefix(href: string) {
  const parts = href.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : null;
}

function sectionIdForFile(fileId: string) {
  return `file:${fileId}`;
}

function sectionIdForPrefix(fileId: string, prefix: string) {
  return `chapter:${fileId}:${encodeURIComponent(prefix)}`;
}

export function buildComicSections(bookId: string, files: ComicFile[], readingUnits: PageUnit[]): ComicSection[] {
  const pagesByPath = new Map<string, PageUnit[]>();
  for (const unit of readingUnits) {
    const key = unit.filePath ?? '';
    pagesByPath.set(key, [...(pagesByPath.get(key) ?? []), unit]);
  }

  const sections: ComicSection[] = [];
  for (const file of files) {
    const filePages = [...(pagesByPath.get(file.path) ?? [])].sort((left, right) => {
      const leftMeta = safeJsonObject(left.metadataJson);
      const rightMeta = safeJsonObject(right.metadataJson);
      return Number(leftMeta.pageInSection ?? leftMeta.pageInVolume ?? left.sortOrder) - Number(rightMeta.pageInSection ?? rightMeta.pageInVolume ?? right.sortOrder);
    });
    if (filePages.length === 0) continue;

    const firstMeta = safeJsonObject(filePages[0].metadataJson);
    const volumeIndex = Number(firstMeta.volumeIndex);
    const hasVolume = files.length > 1 || Number.isFinite(volumeIndex);
    if (hasVolume) {
      const index = Number.isFinite(volumeIndex) ? volumeIndex : file.sortOrder + 1;
      sections.push({
        id: sectionIdForFile(file.id),
        title: String(firstMeta.sectionTitle ?? volumeTitle(index, file.path)),
        index,
        fileId: file.id,
        filePath: file.path,
        pageCount: filePages.length,
        firstPage: 1,
        coverUrl: `/api/books/${bookId}/pages/1?fileId=${encodeURIComponent(file.id)}`
      });
      continue;
    }

    const groups = new Map<string, PageUnit[]>();
    for (const page of filePages) {
      const prefix = topLevelPrefix(page.href);
      if (!prefix) continue;
      groups.set(prefix, [...(groups.get(prefix) ?? []), page]);
    }

    if (groups.size > 1) {
      let index = 1;
      for (const [prefix, pages] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0], 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))) {
        sections.push({
          id: sectionIdForPrefix(file.id, prefix),
          title: compactTitle(prefix) || `第 ${index} 话`,
          index,
          fileId: file.id,
          filePath: file.path,
          prefix,
          pageCount: pages.length,
          firstPage: 1,
          coverUrl: `/api/books/${bookId}/pages/1?section=${encodeURIComponent(sectionIdForPrefix(file.id, prefix))}`
        });
        index += 1;
      }
      continue;
    }

    sections.push({
      id: sectionIdForFile(file.id),
      title: '正文',
      index: 1,
      fileId: file.id,
      filePath: file.path,
      pageCount: filePages.length,
      firstPage: 1,
      coverUrl: `/api/books/${bookId}/pages/1?fileId=${encodeURIComponent(file.id)}`
    });
  }

  return sections.sort((left, right) => left.index - right.index || left.title.localeCompare(right.title, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
}

export function selectComicSection(sections: ComicSection[], search: URLSearchParams) {
  const sectionId = search.get('section');
  const fileId = search.get('fileId');
  if (sectionId) return sections.find((section) => section.id === sectionId) ?? null;
  if (fileId) return sections.find((section) => section.fileId === fileId && !section.prefix) ?? sections.find((section) => section.fileId === fileId) ?? null;
  return sections[0] ?? null;
}

export function unitsForComicSection(section: ComicSection, readingUnits: PageUnit[]) {
  return readingUnits
    .filter((unit) => {
      if (unit.filePath !== section.filePath) return false;
      if (!section.prefix) return true;
      return unit.href === section.prefix || unit.href.startsWith(`${section.prefix}/`);
    })
    .sort((left, right) => {
      const leftMeta = safeJsonObject(left.metadataJson);
      const rightMeta = safeJsonObject(right.metadataJson);
      return Number(leftMeta.pageInSection ?? leftMeta.pageInVolume ?? left.sortOrder) - Number(rightMeta.pageInSection ?? rightMeta.pageInVolume ?? right.sortOrder);
    });
}

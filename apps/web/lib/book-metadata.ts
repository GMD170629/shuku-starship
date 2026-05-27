import type { ReadingFormat, ReadingStatus } from '@prisma/client';

export const readingFormats = ['TXT', 'PDF', 'IMAGE', 'COMIC', 'EPUB', 'UNKNOWN'] as const satisfies readonly ReadingFormat[];
export const readingStatuses = ['WANT', 'READING', 'FINISHED'] as const satisfies readonly ReadingStatus[];

export const formatLabels: Record<ReadingFormat, string> = {
  TXT: 'TXT',
  PDF: 'PDF',
  IMAGE: '图片',
  COMIC: '漫画',
  EPUB: 'EPUB',
  UNKNOWN: '未知'
};

export const statusLabels: Record<ReadingStatus, string> = {
  WANT: '想读',
  READING: '在读',
  FINISHED: '已读'
};

const localizedFormatMap: Record<string, ReadingFormat> = {
  TXT: 'TXT',
  PDF: 'PDF',
  IMAGE: 'IMAGE',
  COMIC: 'COMIC',
  EPUB: 'EPUB',
  UNKNOWN: 'UNKNOWN',
  漫画: 'COMIC',
  图片: 'IMAGE',
  未知: 'UNKNOWN'
};

export function parseReadingFormat(value: unknown): ReadingFormat | null {
  if (typeof value !== 'string') return null;
  return localizedFormatMap[value.trim().toUpperCase()] ?? localizedFormatMap[value.trim()] ?? null;
}

export function parseReadingStatus(value: unknown): ReadingStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return readingStatuses.includes(normalized as ReadingStatus) ? (normalized as ReadingStatus) : null;
}

export function normalizeTags(tags: unknown) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
}

export function mergeTags(existing: string[], addTags: unknown, removeTags: unknown) {
  const additions = normalizeTags(addTags);
  const removals = new Set(normalizeTags(removeTags));
  return [...new Set([...existing, ...additions])].filter((tag) => !removals.has(tag));
}

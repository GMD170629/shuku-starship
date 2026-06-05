import type { PublicationStatus, ReadingFormat, ReadingStatus, TrackingStatus } from '@prisma/client';

export const readingFormats = ['COMIC', 'EPUB'] as const satisfies readonly ReadingFormat[];
export const readingStatuses = ['WANT', 'READING', 'FINISHED'] as const satisfies readonly ReadingStatus[];
export const publicationStatuses = ['UNKNOWN', 'ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED'] as const satisfies readonly PublicationStatus[];
export const trackingStatuses = ['NOT_TRACKING', 'TRACKING', 'PAUSED', 'IGNORED'] as const satisfies readonly TrackingStatus[];

export const formatLabels: Record<ReadingFormat, string> = {
  COMIC: '漫画',
  EPUB: 'EPUB'
};

export const statusLabels: Record<ReadingStatus, string> = {
  WANT: '想读',
  READING: '在读',
  FINISHED: '已读'
};

export const publicationStatusLabels: Record<PublicationStatus, string> = {
  UNKNOWN: '未知',
  ONGOING: '连载中',
  COMPLETED: '已完结',
  HIATUS: '休刊中',
  CANCELLED: '已腰斩'
};

export const trackingStatusLabels: Record<TrackingStatus, string> = {
  NOT_TRACKING: '未追更',
  TRACKING: '追更中',
  PAUSED: '暂停追更',
  IGNORED: '忽略更新'
};

const localizedFormatMap: Record<string, ReadingFormat> = {
  COMIC: 'COMIC',
  EPUB: 'EPUB',
  漫画: 'COMIC'
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

export function parsePublicationStatus(value: unknown): PublicationStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return publicationStatuses.includes(normalized as PublicationStatus) ? (normalized as PublicationStatus) : null;
}

export function parseTrackingStatus(value: unknown): TrackingStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return trackingStatuses.includes(normalized as TrackingStatus) ? (normalized as TrackingStatus) : null;
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

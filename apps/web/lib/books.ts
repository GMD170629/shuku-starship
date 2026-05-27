import type { Book, BookFile, LibraryPath, ReadingFormat, ReadingProgress, ReadingStatus } from '@prisma/client';
import { formatLabels, statusLabels } from './book-metadata';

export type BookView = {
  id: string;
  title: string;
  author: string;
  type: string;
  formatValue: ReadingFormat;
  format: string;
  size: string;
  progress: number;
  statusValue: ReadingStatus;
  status: string;
  ignored: boolean;
  tags: string[];
  added: string;
  lastRead: string;
  lastReadAt: string | null;
  chapter: string;
  chapterCount: number | null;
  pageCount: number | null;
  desc: string;
  path: string;
  fileHash: string;
  gradient: string;
  coverStatus: string;
  coverUrl: string;
  files: Array<{
    id: string;
    path: string;
    mimeType: string;
    kind: string;
    sortOrder: number;
    size: string;
  }>;
};

const gradients = [
  'from-slate-950 via-blue-800 to-cyan-500',
  'from-emerald-900 via-teal-700 to-lime-400',
  'from-rose-900 via-fuchsia-800 to-amber-300',
  'from-zinc-900 via-slate-700 to-stone-300'
];

export function formatBytes(value: bigint | number) {
  const bytes = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function parseTags(tags: string) {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function formatLabel(format: ReadingFormat) {
  return formatLabels[format] ?? '未知';
}

export function toBookView(
  book: Book & {
    files?: BookFile[];
    libraryPath?: LibraryPath | null;
    progresses?: ReadingProgress[];
  }
): BookView {
  const progress = book.progresses?.[0];
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
  return {
    id: book.id,
    title: book.title,
    author: book.author ?? '未知作者',
    type: formatLabel(book.format),
    formatValue: book.format,
    format: formatLabel(book.format),
    size: formatBytes(book.sizeBytes),
    progress: percent,
    statusValue: book.status,
    status: statusLabels[book.status],
    ignored: book.hidden,
    tags: parseTags(book.tags),
    added: book.createdAt.toISOString().slice(0, 10),
    lastReadAt: progress?.updatedAt.toISOString() ?? null,
    lastRead: progress?.updatedAt.toISOString().slice(0, 10) ?? '尚未阅读',
    chapter: progress?.page ? `第 ${progress.page} 页` : '未开始',
    chapterCount: book.chapterCount,
    pageCount: book.pageCount,
    desc: book.description ?? '暂无简介，可在详情页补充元数据。',
    path: book.sourcePath,
    fileHash: book.sourceHash,
    gradient: gradients[Math.abs(hashCode(book.id)) % gradients.length],
    coverStatus: book.coverStatus,
    coverUrl: `/api/books/${book.id}/cover?size=medium`,
    files: (book.files ?? []).map((file) => ({
      id: file.id,
      path: file.path,
      mimeType: file.mimeType,
      kind: file.kind,
      sortOrder: file.sortOrder,
      size: formatBytes(file.sizeBytes)
    }))
  };
}

function hashCode(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

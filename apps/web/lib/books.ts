import type {
  LibraryEdition,
  LibraryFile,
  LibraryReadingProgress,
  LibraryVolume,
  LibraryWork,
  ReadingFormat,
  ReadingStatus
} from '@prisma/client';
import { formatLabels, statusLabels } from './book-metadata';

export type WorkView = {
  id: string;
  workId: string;
  editionId: string | null;
  monitorFolderId: string | null;
  title: string;
  author: string;
  type: 'ebook' | 'comic';
  formatValue: ReadingFormat;
  format: string;
  size: string;
  progress: number;
  statusValue: ReadingStatus;
  status: string;
  ignored: boolean;
  organized: boolean;
  tags: string[];
  seriesName: string | null;
  seriesIndex: number | null;
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
  totalUnits: number;
  readingProgress: number;
  importStatus: string;
  importError: string | null;
  importedAt: string;
  files: Array<{
    id: string;
    path: string;
    mimeType: string;
    kind: string;
    sortOrder: number;
    size: string;
  }>;
  versionCount: number;
  volumeCount: number;
  primaryEditionId: string | null;
  primaryEditionName: string | null;
  recentEditionId: string | null;
  volumes: Array<{
    id: string;
    editionId: string;
    title: string;
    volumeIndex: number | null;
    sortOrder: number;
    pageCount: number | null;
    chapterCount: number | null;
    coverUrl: string;
  }>;
  editions: Array<{
    id: string;
    workId: string;
    formatValue: ReadingFormat;
    format: string;
    versionName: string;
    primary: boolean;
    hidden: boolean;
    size: string;
    pageCount: number | null;
    chapterCount: number | null;
    progress: number;
    lastReadAt: string | null;
    coverUrl: string;
    files: WorkView['files'];
    volumes: WorkView['volumes'];
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

function publicEditionFormat(edition: Pick<LibraryEdition, 'format'> & { files?: Pick<LibraryFile, 'path'>[] }) {
  if (edition.format === 'COMIC') {
    const ext = edition.files?.[0]?.path.split('.').pop()?.toLowerCase();
    if (ext === 'cbz') return 'CBZ';
    if (ext === 'zip') return 'ZIP';
    return '漫画';
  }
  return formatLabel(edition.format);
}

export type WorkWithLibrary = LibraryWork & {
  editions?: Array<
    LibraryEdition & {
      files?: LibraryFile[];
      volumes?: LibraryVolume[];
      progresses?: LibraryReadingProgress[];
    }
  >;
  progresses?: LibraryReadingProgress[];
};

function editionUnits(edition: LibraryEdition) {
  return edition.format === 'COMIC' ? (edition.pageCount ?? 0) : (edition.chapterCount ?? 0);
}

function editionType(format: ReadingFormat): 'ebook' | 'comic' {
  return format === 'COMIC' ? 'comic' : 'ebook';
}

function volumeView(workId: string, volume: LibraryVolume) {
  return {
    id: volume.id,
    editionId: volume.editionId,
    title: volume.title,
    volumeIndex: volume.volumeIndex,
    sortOrder: volume.sortOrder,
    pageCount: volume.pageCount,
    chapterCount: volume.chapterCount,
    coverUrl: `/api/volumes/${volume.id}/cover?workId=${encodeURIComponent(workId)}`
  };
}

export function toWorkView(work: WorkWithLibrary): WorkView {
  const editions = [...(work.editions ?? [])].filter((edition) => !edition.hidden).sort((a, b) => Number(b.primary) - Number(a.primary) || a.createdAt.getTime() - b.createdAt.getTime());
  const recentProgress = editions.flatMap((edition) => edition.progresses ?? []).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
  const primary = editions.find((edition) => edition.id === work.primaryEditionId) ?? editions.find((edition) => edition.primary) ?? editions[0] ?? null;
  const recentEdition = recentProgress ? editions.find((edition) => edition.id === recentProgress.editionId) ?? primary : primary;
  const displayEdition = recentEdition ?? primary;
  const progress = recentProgress ?? displayEdition?.progresses?.[0] ?? null;
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
  const volumes = editions.flatMap((edition) => (edition.volumes ?? []).map((volume) => volumeView(work.id, volume)));
  const files = displayEdition?.files ?? [];
  const firstFile = files[0];
  const totalSize = editions.flatMap((edition) => edition.files ?? []).reduce((total, file) => total + BigInt(file.sizeBytes), BigInt(0));
  const editionViews = editions.map((edition) => {
    const editionProgress = edition.progresses?.[0] ?? null;
    return {
      id: edition.id,
      workId: edition.workId,
      formatValue: edition.format,
      format: publicEditionFormat(edition),
      versionName: edition.versionName,
      primary: edition.id === work.primaryEditionId || edition.primary,
      hidden: edition.hidden,
      size: formatBytes(edition.sizeBytes),
      pageCount: edition.pageCount,
      chapterCount: edition.chapterCount,
      progress: Math.max(0, Math.min(100, Math.round(editionProgress?.percent ?? 0))),
      lastReadAt: editionProgress?.updatedAt.toISOString() ?? null,
      coverUrl: `/api/editions/${edition.id}/cover?size=medium`,
      files: (edition.files ?? []).map((file) => ({
        id: file.id,
        path: file.path,
        mimeType: file.mimeType,
        kind: file.kind,
        sortOrder: file.sortOrder,
        size: formatBytes(file.sizeBytes)
      })),
      volumes: (edition.volumes ?? []).map((volume) => volumeView(work.id, volume))
    };
  });

  return {
    id: work.id,
    workId: work.id,
    editionId: displayEdition?.id ?? null,
    monitorFolderId: work.monitorFolderId,
    title: work.title,
    author: work.author ?? '未知作者',
    type: editionType(work.workType),
    formatValue: displayEdition?.format ?? work.workType,
    format: displayEdition ? publicEditionFormat(displayEdition) : formatLabel(work.workType),
    size: formatBytes(totalSize),
    progress: percent,
    statusValue: work.status,
    status: statusLabels[work.status],
    ignored: work.hidden,
    organized: work.organized,
    tags: parseTags(work.tags),
    seriesName: null,
    seriesIndex: null,
    added: work.createdAt.toISOString().slice(0, 10),
    importedAt: work.createdAt.toISOString(),
    lastReadAt: progress?.updatedAt.toISOString() ?? null,
    lastRead: progress?.updatedAt.toISOString().slice(0, 10) ?? '尚未阅读',
    chapter: progress?.page ? `第 ${progress.page} 页` : '未开始',
    chapterCount: displayEdition?.chapterCount ?? null,
    pageCount: displayEdition?.pageCount ?? null,
    desc: work.description ?? displayEdition?.description ?? '暂无简介，可在详情页补充元数据。',
    path: firstFile?.path ?? '',
    fileHash: firstFile?.fullHash ?? '',
    gradient: gradients[Math.abs(hashCode(work.id)) % gradients.length],
    coverStatus: work.coverStatus,
    coverUrl: `/api/works/${work.id}/cover?size=medium`,
    totalUnits: displayEdition ? editionUnits(displayEdition) : 0,
    readingProgress: percent,
    importStatus: displayEdition?.importStatus ?? 'PENDING',
    importError: displayEdition?.importError ?? null,
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      mimeType: file.mimeType,
      kind: file.kind,
      sortOrder: file.sortOrder,
      size: formatBytes(file.sizeBytes)
    })),
    versionCount: editions.length,
    volumeCount: volumes.length,
    primaryEditionId: work.primaryEditionId,
    primaryEditionName: primary?.versionName ?? null,
    recentEditionId: recentEdition?.id ?? null,
    volumes,
    editions: editionViews
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

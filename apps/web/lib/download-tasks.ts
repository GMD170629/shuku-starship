import path from 'node:path';
import fs from 'node:fs';
import { Prisma, type DownloadTask, type Source, type SourceSearchRecord } from '@prisma/client';

export const downloadTaskTypes = ['manual', 'telegram', 'torrent', 'http', 'blackhole'] as const;
export type DownloadTaskType = (typeof downloadTaskTypes)[number];

export const downloadTaskStatuses = ['queued', 'downloading', 'downloaded', 'importing', 'completed', 'failed', 'cancelled'] as const;
export type DownloadTaskStatus = (typeof downloadTaskStatuses)[number];

const sensitiveKeyPattern = /(token|cookie|passkey|password|secret|authorization|api[-_]?key|access[-_]?key|auth)/i;
const sensitiveQueryPattern = /^(token|cookie|passkey|password|secret|authorization|api[-_]?key|access[-_]?key|auth)$/i;

export type DownloadTaskView = {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  searchRecordId: string | null;
  bookId: string | null;
  type: string;
  status: string;
  displayName: string;
  remoteRef: unknown;
  savePath: string | null;
  filePath: string | null;
  errorMessage: string | null;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
};

export function getDownloadInboxPath() {
  return process.env.DOWNLOAD_INBOX_PATH?.trim() || './downloads/inbox';
}

export function getResolvedDownloadInboxPath() {
  return path.resolve(process.cwd(), getDownloadInboxPath());
}

export function ensureDownloadInboxDir() {
  fs.mkdirSync(getResolvedDownloadInboxPath(), { recursive: true });
}

ensureDownloadInboxDir();

export function parseDownloadTaskType(value: unknown): DownloadTaskType | null {
  return typeof value === 'string' && downloadTaskTypes.includes(value as DownloadTaskType) ? value as DownloadTaskType : null;
}

export function parseDownloadTaskStatus(value: unknown): DownloadTaskStatus | null {
  return typeof value === 'string' && downloadTaskStatuses.includes(value as DownloadTaskStatus) ? value as DownloadTaskStatus : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function inferDownloadTaskType(providerType: string, downloadMeta?: unknown): DownloadTaskType {
  const meta = jsonObject(downloadMeta);
  if (providerType === 'telegram') return 'telegram';
  if (providerType === 'pt_rss' || providerType === 'torrent') {
    return meta.type === 'blackhole' || meta.kind === 'blackhole' || typeof meta.blackholePath === 'string' ? 'blackhole' : 'torrent';
  }
  if (providerType === 'http' || providerType === 'rss' || providerType === 'comic_api') return 'http';
  return 'manual';
}

export function hasUsableDownloadMeta(providerType: string, downloadMeta: unknown) {
  const meta = jsonObject(downloadMeta);
  if (typeof meta.downloadUrl === 'string' && meta.downloadUrl.trim()) return true;
  if (providerType === 'pt_rss' && typeof meta.magnetUrl === 'string' && meta.magnetUrl.trim()) return true;
  if (providerType === 'pt_rss' && typeof meta.torrentUrl === 'string' && meta.torrentUrl.trim()) return true;
  if (providerType === 'pt_rss' && typeof meta.blackholePath === 'string' && meta.blackholePath.trim()) return true;
  if (providerType === 'telegram' && typeof meta.fileId === 'string' && meta.fileId.trim()) return true;
  if (providerType === 'telegram' && typeof meta.messageId === 'string' && meta.messageId.trim()) return true;
  return false;
}

function isWithinDownloadInbox(value: string) {
  const inbox = getResolvedDownloadInboxPath();
  const resolved = path.resolve(process.cwd(), value);
  return resolved === inbox || resolved.startsWith(`${inbox}${path.sep}`);
}

export function validateDownloadInboxPath(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${fieldName} 必须是字符串`);
  if (!isWithinDownloadInbox(value)) throw new Error(`${fieldName} 只能位于 DOWNLOAD_INBOX_PATH`);
  return value;
}

function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveQueryPattern.test(key)) url.searchParams.set(key, '[redacted]');
    }
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeRemoteRef(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  const seen = new WeakSet<object>();
  function sanitize(input: unknown): unknown {
    if (typeof input === 'string') return sanitizeUrl(input);
    if (typeof input !== 'object' || input === null) return input;
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(sanitize);
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? '[redacted]' : sanitize(item)
      ])
    );
  }
  return sanitize(value) as Prisma.InputJsonValue;
}

export function createRemoteRefFromSearchRecord(record: SourceSearchRecord) {
  return sanitizeRemoteRef({
    providerType: record.providerType,
    externalId: record.externalId,
    externalUrl: record.externalUrl,
    format: record.format,
    size: record.size,
    downloadMeta: record.downloadMeta
  });
}

function publicInboxPath(value: string | null) {
  if (!value) return null;
  if (!isWithinDownloadInbox(value)) return 'downloads/inbox';
  const relative = path.relative(getResolvedDownloadInboxPath(), path.resolve(process.cwd(), value));
  return relative ? `downloads/inbox/${relative.split(path.sep).join('/')}` : 'downloads/inbox';
}

export function toDownloadTaskView(task: DownloadTask, sourceNameById: Map<string, string> = new Map()): DownloadTaskView {
  return {
    id: task.id,
    sourceId: task.sourceId,
    sourceName: task.sourceId ? sourceNameById.get(task.sourceId) ?? null : null,
    searchRecordId: task.searchRecordId,
    bookId: task.bookId,
    type: task.type,
    status: task.status,
    displayName: task.displayName,
    remoteRef: task.remoteRef,
    savePath: publicInboxPath(task.savePath),
    filePath: publicInboxPath(task.filePath),
    errorMessage: task.errorMessage,
    progress: task.progress,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString()
  };
}

export function sourceNamesById(sources: Array<Pick<Source, 'id' | 'name'>>) {
  return new Map(sources.map((source) => [source.id, source.name]));
}

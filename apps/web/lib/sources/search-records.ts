import { Prisma, type Source, type SourceSearchRecord } from '@prisma/client';
import type { SourceSearchResult } from './source-provider';

export const sourceSearchRecordStatuses = ['new', 'saved', 'ignored', 'download_created', 'completed', 'imported', 'failed'] as const;
export type SourceSearchRecordStatus = (typeof sourceSearchRecordStatuses)[number];

export type SourceSearchRecordView = {
  id: string;
  sourceId: string;
  sourceName?: string;
  providerType: string;
  externalId: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  description: string | null;
  coverUrl: string | null;
  externalUrl: string | null;
  format: string | null;
  size: string | null;
  language: string | null;
  publishedAt: string | null;
  downloadAvailable: boolean;
  downloadMeta: Prisma.JsonValue | null;
  raw: Prisma.JsonValue | null;
  status: SourceSearchRecordStatus | string;
  createdAt: string;
  updatedAt: string;
};

export function parseSourceSearchRecordStatus(value: unknown): SourceSearchRecordStatus | null {
  return typeof value === 'string' && sourceSearchRecordStatuses.includes(value as SourceSearchRecordStatus) ? value as SourceSearchRecordStatus : null;
}

function nullableString(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parsePublishedAt(value: unknown) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function jsonValue(value: unknown) {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

export function searchResultToRecordData(source: Source, result: SourceSearchResult) {
  return {
    sourceId: source.id,
    providerType: result.providerType || source.providerType,
    externalId: result.externalId,
    title: result.title.trim(),
    subtitle: nullableString(result.subtitle),
    author: nullableString(result.author),
    description: nullableString(result.description),
    coverUrl: nullableString(result.coverUrl),
    externalUrl: nullableString(result.externalUrl),
    format: nullableString(result.format),
    size: nullableString(result.size),
    language: nullableString(result.language),
    publishedAt: parsePublishedAt(result.publishedAt),
    downloadAvailable: Boolean(result.downloadAvailable),
    downloadMeta: jsonValue(result.downloadMeta),
    raw: jsonValue(result.raw)
  };
}

export function toSourceSearchRecordView(record: SourceSearchRecord & { source?: Pick<Source, 'name'> | null }): SourceSearchRecordView {
  return {
    id: record.id,
    sourceId: record.sourceId,
    sourceName: record.source?.name,
    providerType: record.providerType,
    externalId: record.externalId,
    title: record.title,
    subtitle: record.subtitle,
    author: record.author,
    description: record.description,
    coverUrl: record.coverUrl,
    externalUrl: record.externalUrl,
    format: record.format,
    size: record.size,
    language: record.language,
    publishedAt: record.publishedAt?.toISOString() ?? null,
    downloadAvailable: record.downloadAvailable,
    downloadMeta: record.downloadMeta,
    raw: record.raw,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  };
}

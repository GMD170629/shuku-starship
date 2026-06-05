import type { Source } from '@prisma/client';
import type { SourceProvider, SourceSearchQuery, SourceSearchResult } from '../source-provider';

type ManualItem = {
  externalId?: unknown;
  title?: unknown;
  subtitle?: unknown;
  author?: unknown;
  description?: unknown;
  coverUrl?: unknown;
  externalUrl?: unknown;
  format?: unknown;
  size?: unknown;
  language?: unknown;
  publishedAt?: unknown;
  downloadUrl?: unknown;
};

function configObject(source: Source): Record<string, unknown> {
  return source.config && typeof source.config === 'object' && !Array.isArray(source.config)
    ? source.config as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function itemsFromSource(source: Source) {
  const items = configObject(source).items;
  return Array.isArray(items) ? items.filter((item): item is ManualItem => Boolean(item) && typeof item === 'object') : [];
}

function matchesKeyword(item: ManualItem, keyword: string) {
  const haystack = [
    item.externalId,
    item.title,
    item.subtitle,
    item.author,
    item.description,
    item.format,
    item.language
  ].map((value) => stringValue(value)?.toLocaleLowerCase() ?? '').join('\n');
  return haystack.includes(keyword.toLocaleLowerCase());
}

function itemToResult(source: Source, item: ManualItem, index: number): SourceSearchResult | null {
  const title = stringValue(item.title);
  const externalId = stringValue(item.externalId);
  if (!title || !externalId) return null;
  const downloadUrl = stringValue(item.downloadUrl);
  return {
    sourceId: source.id,
    providerType: source.providerType,
    externalId,
    title,
    subtitle: stringValue(item.subtitle),
    author: stringValue(item.author),
    description: stringValue(item.description),
    coverUrl: stringValue(item.coverUrl),
    externalUrl: stringValue(item.externalUrl) ?? downloadUrl,
    format: stringValue(item.format),
    size: stringValue(item.size),
    language: stringValue(item.language),
    publishedAt: stringValue(item.publishedAt),
    downloadAvailable: Boolean(downloadUrl),
    downloadMeta: downloadUrl ? { type: 'manual', downloadUrl } : undefined,
    raw: { manualItem: true, index, item }
  };
}

export const manualSourceProvider: SourceProvider = {
  providerType: 'manual',
  capabilities: { search: true, download: false },
  async search(source, query) {
    const keyword = query.keyword.trim();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return itemsFromSource(source)
      .filter((item) => matchesKeyword(item, keyword))
      .slice((page - 1) * pageSize, page * pageSize)
      .map((item, index) => itemToResult(source, item, index))
      .filter((result): result is SourceSearchResult => Boolean(result));
  },
  async test(source) {
    const items = itemsFromSource(source);
    const invalidCount = items.filter((item) => !stringValue(item.externalId) || !stringValue(item.title)).length;
    if (invalidCount > 0) return { ok: false, message: `manual items 中有 ${invalidCount} 条缺少 externalId 或 title。` };
    return { ok: true, message: `manual 配置有效，可搜索 ${items.length} 条手动结果。` };
  }
};

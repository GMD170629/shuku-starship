import type { Source } from '@prisma/client';
import type { SourceProvider, SourceSearchQuery, SourceSearchResult } from '../source-provider';

type HttpItem = {
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
  return Array.isArray(items) ? items.filter((item): item is HttpItem => Boolean(item) && typeof item === 'object') : [];
}

function isHttpUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function matchesKeyword(item: HttpItem, keyword: string) {
  const lowerKeyword = keyword.toLocaleLowerCase();
  return [
    item.externalId,
    item.title,
    item.subtitle,
    item.author,
    item.description,
    item.format,
    item.size,
    item.language,
    item.downloadUrl
  ].some((value) => stringValue(value)?.toLocaleLowerCase().includes(lowerKeyword));
}

function itemToResult(source: Source, item: HttpItem, index: number): SourceSearchResult | null {
  const externalId = stringValue(item.externalId);
  const title = stringValue(item.title);
  const downloadUrl = stringValue(item.downloadUrl);
  if (!externalId || !title || !isHttpUrl(downloadUrl)) return null;
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
    downloadAvailable: true,
    downloadMeta: {
      type: 'http',
      downloadUrl
    },
    raw: { httpItem: true, index, item }
  };
}

export const httpSourceProvider: SourceProvider = {
  providerType: 'http',
  capabilities: { search: true, download: true },
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
    if (items.length === 0) return { ok: false, message: 'HTTP 源需要在 config.items 中配置至少一条文件。' };
    const invalidCount = items.filter((item) => !stringValue(item.externalId) || !stringValue(item.title) || !isHttpUrl(stringValue(item.downloadUrl))).length;
    if (invalidCount > 0) return { ok: false, message: `HTTP items 中有 ${invalidCount} 条缺少 externalId、title 或有效 downloadUrl。` };
    return { ok: true, message: `HTTP 配置有效，可搜索 ${items.length} 条文件。` };
  }
};

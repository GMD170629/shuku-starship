import type { Source } from '@prisma/client';

export type SourceSearchQuery = {
  keyword: string;
  kind?: 'novel' | 'comic' | 'mixed';
  page?: number;
  pageSize?: number;
};

export type SourceSearchResult = {
  sourceId: string;
  providerType: string;
  externalId: string;
  title: string;
  subtitle?: string;
  author?: string;
  description?: string;
  coverUrl?: string;
  externalUrl?: string;
  format?: string;
  size?: string;
  language?: string;
  publishedAt?: string;
  downloadAvailable: boolean;
  downloadMeta?: unknown;
  raw?: unknown;
};

export interface SourceProvider {
  providerType: string;
  capabilities: {
    search: boolean;
    download: boolean;
    rss?: boolean;
    telegram?: boolean;
    torrent?: boolean;
    requiresAuth?: boolean;
  };
  search(source: Source, query: SourceSearchQuery): Promise<SourceSearchResult[]>;
  test?(source: Source): Promise<{
    ok: boolean;
    message: string;
    details?: unknown;
  }>;
}

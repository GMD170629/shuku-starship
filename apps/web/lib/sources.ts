import type { Prisma, Source } from '@prisma/client';

export const sourceProviderTypes = ['manual', 'telegram', 'pt_rss', 'comic_api', 'rss', 'http'] as const;
export const sourceKinds = ['novel', 'comic', 'mixed', 'metadata'] as const;

export type SourceProviderType = (typeof sourceProviderTypes)[number];
export type SourceKind = (typeof sourceKinds)[number];

export const sourceProviderLabels: Record<SourceProviderType, string> = {
  manual: '手动源',
  telegram: 'Z-Library Telegram Bot',
  pt_rss: 'PT RSS 源',
  comic_api: '漫画 API 源',
  rss: '通用 RSS 源',
  http: '通用 HTTP 源'
};

export const sourceKindLabels: Record<SourceKind, string> = {
  novel: '小说',
  comic: '漫画',
  mixed: '混合',
  metadata: '元数据'
};

export type MaskedSecret = {
  configured: true;
  masked: string;
  tail: string;
};

export type SourceView = {
  id: string;
  name: string;
  kind: SourceKind;
  kindLabel: string;
  providerType: SourceProviderType;
  providerTypeLabel: string;
  enabled: boolean;
  priority: number;
  config: Prisma.JsonValue | null;
  credentialsKey: string | null;
  capabilities: Prisma.JsonValue | null;
  rateLimit: Prisma.JsonValue | null;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const sensitiveKeyPattern = /(^url$)|token|cookie|passkey|password|session|secret|apikey|api_key|apiid|api_id|apihash|api_hash|rsskey|rss_key|rssurl|rss_url/i;

export function isSourceProviderType(value: unknown): value is SourceProviderType {
  return typeof value === 'string' && sourceProviderTypes.includes(value as SourceProviderType);
}

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && sourceKinds.includes(value as SourceKind);
}

export function maskSensitiveValue(value: unknown): MaskedSecret {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const tail = text.slice(-4);
  return {
    configured: true,
    masked: `已配置${tail ? `，尾号 ****${tail}` : ''}`,
    tail
  };
}

export function maskSensitiveJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskSensitiveJson(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sensitiveKeyPattern.test(key) && item !== null && item !== undefined && item !== ''
      ? maskSensitiveValue(item)
      : maskSensitiveJson(item);
  }
  return output as T;
}

export function toSourceView(source: Source): SourceView {
  const kind = isSourceKind(source.kind) ? source.kind : 'mixed';
  const providerType = isSourceProviderType(source.providerType) ? source.providerType : 'manual';
  return {
    id: source.id,
    name: source.name,
    kind,
    kindLabel: sourceKindLabels[kind],
    providerType,
    providerTypeLabel: sourceProviderLabels[providerType],
    enabled: source.enabled,
    priority: source.priority,
    config: maskSensitiveJson(source.config) ?? null,
    credentialsKey: source.credentialsKey ? maskSensitiveValue(source.credentialsKey).masked : null,
    capabilities: maskSensitiveJson(source.capabilities) ?? null,
    rateLimit: maskSensitiveJson(source.rateLimit) ?? null,
    lastTestAt: source.lastTestAt?.toISOString() ?? null,
    lastTestStatus: source.lastTestStatus,
    lastError: source.lastError,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString()
  };
}

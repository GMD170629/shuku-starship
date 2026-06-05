import crypto from 'node:crypto';
import type { Source } from '@prisma/client';
import type { SourceProvider, SourceSearchQuery, SourceSearchResult } from '../source-provider';

type TelegramZLibraryConfig = {
  botUsername?: string;
  mode?: string;
  gatewayUrl?: string;
  searchCommand?: string;
  resultParseMode?: string;
  downloadEnabled?: boolean;
  cooldown?: number;
};

type GatewayResult = {
  externalId?: unknown;
  title?: unknown;
  subtitle?: unknown;
  author?: unknown;
  description?: unknown;
  coverUrl?: unknown;
  externalUrl?: unknown;
  telegramUrl?: unknown;
  format?: unknown;
  size?: unknown;
  language?: unknown;
  publishedAt?: unknown;
  downloadUrl?: unknown;
  fileId?: unknown;
  messageId?: unknown;
  raw?: unknown;
};

function configObject(source: Source): Record<string, unknown> {
  return source.config && typeof source.config === 'object' && !Array.isArray(source.config)
    ? source.config as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function parseConfig(source: Source): TelegramZLibraryConfig {
  const config = configObject(source);
  const cooldown = Number(config.cooldown ?? 0);
  return {
    botUsername: normalizeBotUsername(stringValue(config.botUsername)),
    mode: stringValue(config.mode) ?? 'zlibrary_bot',
    gatewayUrl: stringValue(config.gatewayUrl),
    searchCommand: stringValue(config.searchCommand) ?? '/search',
    resultParseMode: stringValue(config.resultParseMode) ?? 'zlibrary_text',
    downloadEnabled: config.downloadEnabled === true,
    cooldown: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 0
  };
}

function normalizeBotUsername(value: string | undefined) {
  return value?.replace(/^@/, '').trim() || undefined;
}

function isValidBotUsername(value: string | undefined) {
  return Boolean(value && /^[A-Za-z0-9_]{3,64}$/.test(value));
}

function hashRef(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function telegramBotUrl(botUsername: string) {
  return `https://t.me/${encodeURIComponent(botUsername)}`;
}

function handoffResult(source: Source, query: SourceSearchQuery, config: TelegramZLibraryConfig): SourceSearchResult[] {
  const botUsername = config.botUsername;
  if (!botUsername) throw new Error('请配置 Z-Library Telegram Bot 用户名');
  const keyword = query.keyword.trim();
  return [{
    sourceId: source.id,
    providerType: source.providerType,
    externalId: `zlib_tg:${hashRef(`${source.id}:${botUsername}:${keyword}`)}`,
    title: `在 Z-Library Telegram Bot 搜索：${keyword}`,
    subtitle: `@${botUsername} · ${config.searchCommand ?? '/search'}`,
    description: '当前源未配置 Telegram gateway。请打开外部链接，在 Telegram 中向 Z-Library Bot 发送搜索关键词。',
    externalUrl: telegramBotUrl(botUsername),
    format: query.kind === 'comic' ? 'comic' : 'ebook',
    downloadAvailable: false,
    downloadMeta: {
      type: 'telegram_zlibrary_handoff',
      botUsername,
      searchCommand: config.searchCommand,
      keyword
    },
    raw: { telegramZLibrary: true, handoff: true }
  }];
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

function gatewayItems(payload: unknown): GatewayResult[] {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).results
    : payload;
  return Array.isArray(value) ? value.filter((item): item is GatewayResult => Boolean(item) && typeof item === 'object') : [];
}

function gatewayResultToSearchResult(source: Source, item: GatewayResult, index: number, config: TelegramZLibraryConfig): SourceSearchResult | null {
  const title = stringValue(item.title);
  if (!title) return null;
  const downloadUrl = stringValue(item.downloadUrl);
  const fileId = stringValue(item.fileId);
  const messageId = stringValue(item.messageId);
  const externalUrl = stringValue(item.externalUrl) ?? stringValue(item.telegramUrl) ?? (config.botUsername ? telegramBotUrl(config.botUsername) : undefined);
  const externalId = stringValue(item.externalId) ?? `zlib_tg:${hashRef(`${source.id}:${title}:${fileId ?? messageId ?? index}`)}`;
  const canDownload = Boolean(config.downloadEnabled && (isHttpUrl(downloadUrl) || fileId || messageId));
  return {
    sourceId: source.id,
    providerType: source.providerType,
    externalId,
    title,
    subtitle: stringValue(item.subtitle),
    author: stringValue(item.author),
    description: stringValue(item.description),
    coverUrl: stringValue(item.coverUrl),
    externalUrl,
    format: stringValue(item.format) ?? 'ebook',
    size: stringValue(item.size),
    language: stringValue(item.language),
    publishedAt: stringValue(item.publishedAt),
    downloadAvailable: canDownload,
    downloadMeta: canDownload
      ? {
          type: 'telegram_zlibrary',
          botUsername: config.botUsername,
          fileId,
          messageId,
          downloadUrl: isHttpUrl(downloadUrl) ? downloadUrl : undefined
        }
      : undefined,
    raw: { telegramZLibrary: true, gateway: true, item: item.raw ?? item }
  };
}

async function searchViaGateway(source: Source, query: SourceSearchQuery, config: TelegramZLibraryConfig) {
  const gatewayUrl = config.gatewayUrl;
  if (!gatewayUrl || !isHttpUrl(gatewayUrl)) throw new Error('Z-Library Telegram gatewayUrl 必须是 http/https URL');
  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      provider: 'zlibrary_telegram_bot',
      botUsername: config.botUsername,
      searchCommand: config.searchCommand,
      resultParseMode: config.resultParseMode,
      keyword: query.keyword.trim(),
      kind: query.kind,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Z-Library Telegram gateway 搜索失败：HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  return gatewayItems(payload)
    .map((item, index) => gatewayResultToSearchResult(source, item, index, config))
    .filter((result): result is SourceSearchResult => Boolean(result));
}

export const telegramZLibraryProvider: SourceProvider = {
  providerType: 'telegram',
  capabilities: { search: true, download: false, telegram: true, requiresAuth: true },
  async search(source, query) {
    const config = parseConfig(source);
    if (config.botUsername && !isValidBotUsername(config.botUsername)) throw new Error('Z-Library Telegram Bot 用户名格式不正确');
    if (config.gatewayUrl) return searchViaGateway(source, query, config);
    return handoffResult(source, query, config);
  },
  async test(source) {
    const config = parseConfig(source);
    if (!config.botUsername && !config.gatewayUrl) return { ok: false, message: '请配置 Z-Library Telegram Bot 用户名，或配置自建 gatewayUrl。' };
    if (config.botUsername && !isValidBotUsername(config.botUsername)) return { ok: false, message: 'Z-Library Telegram Bot 用户名格式不正确。' };
    if (config.gatewayUrl && !isHttpUrl(config.gatewayUrl)) return { ok: false, message: 'gatewayUrl 必须是 http/https URL。' };
    return {
      ok: true,
      message: config.gatewayUrl
        ? 'Z-Library Telegram Bot 源配置有效，将通过 gateway 执行搜索。'
        : 'Z-Library Telegram Bot 源配置有效，将返回 Telegram handoff 搜索结果。',
      details: {
        botUsername: config.botUsername ? `@${config.botUsername}` : null,
        gatewayConfigured: Boolean(config.gatewayUrl),
        searchCommand: config.searchCommand,
        downloadEnabled: config.downloadEnabled
      }
    };
  }
};

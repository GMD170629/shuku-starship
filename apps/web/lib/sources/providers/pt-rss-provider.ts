import crypto from 'node:crypto';
import type { Source } from '@prisma/client';
import type { SourceProvider, SourceSearchQuery, SourceSearchResult } from '../source-provider';

type PtRssConfig = {
  rssUrl?: string;
  url?: string;
  keywordInclude?: string[];
  keywordExclude?: string[];
  category?: string;
  defaultType?: string;
  cooldown?: number;
};

type RssItem = {
  title: string;
  link: string | null;
  guid: string | null;
  pubDate: string | null;
  enclosure: { url: string | null; type: string | null; length: string | null } | null;
  category: string | null;
};

function configObject(source: Source): Record<string, unknown> {
  return source.config && typeof source.config === 'object' && !Array.isArray(source.config)
    ? source.config as Record<string, unknown>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}

function parseConfig(source: Source): PtRssConfig {
  const config = configObject(source);
  const cooldown = Number(config.cooldown ?? 0);
  return {
    rssUrl: typeof config.rssUrl === 'string' ? config.rssUrl.trim() : undefined,
    url: typeof config.url === 'string' ? config.url.trim() : undefined,
    keywordInclude: stringArray(config.keywordInclude),
    keywordExclude: stringArray(config.keywordExclude),
    category: typeof config.category === 'string' ? config.category.trim() : undefined,
    defaultType: typeof config.defaultType === 'string' ? config.defaultType.trim() : 'comic',
    cooldown: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 0
  };
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function textFromTag(xml: string, tag: string) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]) : null;
}

function attrFromTag(xml: string, tag: string, attr: string) {
  const tagMatch = new RegExp(`<${tag}\\s+([^>]*?)(?:\\/?>)`, 'i').exec(xml);
  if (!tagMatch) return null;
  const attrMatch = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tagMatch[1]);
  return attrMatch ? decodeXml(attrMatch[1]) : null;
}

function parseRssItems(xml: string): RssItem[] {
  const matches = Array.from(xml.matchAll(/<item(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/item>/gi));
  return matches.map((match) => {
    const itemXml = match[1];
    return {
      title: textFromTag(itemXml, 'title') ?? '',
      link: textFromTag(itemXml, 'link'),
      guid: textFromTag(itemXml, 'guid'),
      pubDate: textFromTag(itemXml, 'pubDate'),
      category: textFromTag(itemXml, 'category'),
      enclosure: /<enclosure[\s/>]/i.test(itemXml)
        ? {
            url: attrFromTag(itemXml, 'enclosure', 'url'),
            type: attrFromTag(itemXml, 'enclosure', 'type'),
            length: attrFromTag(itemXml, 'enclosure', 'length')
          }
        : null
    };
  }).filter((item) => item.title);
}

function includesKeyword(text: string, keyword: string) {
  return text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());
}

function titleMatches(item: RssItem, query: SourceSearchQuery, config: PtRssConfig) {
  const title = item.title;
  const keyword = query.keyword.trim();
  if (keyword && !includesKeyword(title, keyword)) return false;
  if (config.category && item.category && !includesKeyword(item.category, config.category)) return false;
  if ((config.keywordInclude ?? []).some((word) => !includesKeyword(title, word))) return false;
  if ((config.keywordExclude ?? []).some((word) => includesKeyword(title, word))) return false;
  return true;
}

function hashRef(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function sanitizePublicUrl(value: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|passkey|cookie|auth|key|secret/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    return url.toString();
  } catch {
    return undefined;
  }
}

function isTorrentLike(value: string | null | undefined) {
  if (!value) return false;
  const lower = value.toLocaleLowerCase();
  return lower.includes('.torrent') || lower.includes('download') || lower.includes('torrent');
}

function itemToResult(source: Source, item: RssItem, index: number): SourceSearchResult {
  const ref = item.guid || item.link || `${item.title}:${item.pubDate ?? index}`;
  const enclosureUrl = item.enclosure?.url ?? null;
  const torrentLink = isTorrentLike(enclosureUrl) ? enclosureUrl : isTorrentLike(item.link) ? item.link : null;
  const downloadSource = enclosureUrl ? 'enclosure' : torrentLink ? 'link' : null;
  const publishedAt = item.pubDate ? new Date(item.pubDate) : null;
  return {
    sourceId: source.id,
    providerType: source.providerType,
    externalId: item.guid?.trim() || `pt_rss:${hashRef(ref)}`,
    title: item.title,
    subtitle: item.category ?? undefined,
    externalUrl: sanitizePublicUrl(item.link),
    format: 'comic',
    publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : undefined,
    downloadAvailable: Boolean(downloadSource),
    downloadMeta: downloadSource
      ? {
          kind: 'torrent',
          source: downloadSource,
          downloadUrl: enclosureUrl ?? torrentLink ?? undefined,
          enclosureType: item.enclosure?.type ?? undefined,
          enclosureLength: item.enclosure?.length ?? undefined,
          refHash: hashRef(enclosureUrl ?? torrentLink ?? ref)
        }
      : undefined,
    raw: {
      rss: true,
      guid: item.guid,
      category: item.category,
      hasEnclosure: Boolean(item.enclosure),
      linkHash: item.link ? hashRef(item.link) : undefined
    }
  };
}

async function fetchRssItems(rssUrl: string) {
  const response = await fetch(rssUrl, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`RSS 读取失败：HTTP ${response.status}`);
  const text = await response.text();
  return parseRssItems(text);
}

export async function previewPtRssSource(source: Source, limit = 5) {
  const config = parseConfig(source);
  const rssUrl = config.rssUrl || config.url;
  if (!rssUrl) throw new Error('请配置 RSS URL');
  const items = await fetchRssItems(rssUrl);
  return items.slice(0, limit).map((item) => ({
    title: item.title,
    publishedAt: item.pubDate,
    category: item.category
  }));
}

export const ptRssProvider: SourceProvider = {
  providerType: 'pt_rss',
  capabilities: { search: true, download: false, rss: true, torrent: true, requiresAuth: true },
  async search(source, query) {
    const config = parseConfig(source);
    const rssUrl = config.rssUrl || config.url;
    if (!rssUrl) throw new Error('请先在 PT RSS 源中配置 RSS URL');
    const items = await fetchRssItems(rssUrl);
    return items
      .filter((item) => titleMatches(item, query, config))
      .slice(0, query.pageSize ?? 20)
      .map((item, index) => itemToResult(source, item, index));
  },
  async test(source) {
    const config = parseConfig(source);
    const rssUrl = config.rssUrl || config.url;
    if (!rssUrl) return { ok: false, message: '请配置 RSS URL。' };
    if ((config.defaultType ?? 'comic') !== 'comic') return { ok: false, message: 'PT RSS 当前仅作为漫画源使用，defaultType 必须是 comic。' };
    try {
      const preview = await previewPtRssSource(source, 5);
      return {
        ok: true,
        message: `RSS 可读取，最近 ${preview.length} 条标题已返回预览。`,
        details: { preview }
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'RSS 测试失败。' };
    }
  }
};

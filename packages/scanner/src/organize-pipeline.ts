import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { prisma } from '@shuku/database';
import type { ImportTask, LibraryEdition, LibraryFile, LibraryMetadata, LibraryVolume, LibraryWork, Prisma } from '@prisma/client';

export type SuggestionField = 'title' | 'author' | 'description' | 'tags' | 'seriesName' | 'seriesIndex' | 'publishedYear';
export type SuggestionSource = 'filename' | 'embedded' | 'aggregation' | 'external' | 'ai' | 'rule';
export type DuplicateAction = 'MERGE_AS_VERSION' | 'MERGE_AS_VOLUME' | 'HIDE_DUPLICATE' | 'KEEP_SEPARATE';

export type PipelineSuggestion = {
  field: SuggestionField;
  currentValue: unknown;
  suggestedValue: unknown;
  source: SuggestionSource;
  confidence: number;
  reason: string;
};

export type RefreshProvider = 'external' | 'ai';
export type MetadataLookupSource = 'bangumi' | 'douban' | 'ai';
export type MetadataApplyField = SuggestionField | 'publisher' | 'coverUrl';

export type MetadataCandidate = {
  id: string;
  source: MetadataLookupSource;
  title?: string | null;
  author?: string | null;
  publisher?: string | null;
  description?: string | null;
  tags?: string[];
  seriesName?: string | null;
  seriesIndex?: number | null;
  publishedYear?: number | null;
  coverUrl?: string | null;
  confidence: number;
  raw: unknown;
};

type ProviderRunResult = {
  provider: RefreshProvider;
  enabled: boolean;
  added: number;
  cacheHit: boolean;
  message?: string;
  error?: string;
};

type ProviderRunOptions = {
  force?: boolean;
};

export type PipelineDuplicate = {
  targetWorkId: string;
  reasons: string[];
  confidence: number;
  suggestedAction: DuplicateAction;
};

export type OrganizeContext = {
  work: LibraryWork & {
    editions: Array<LibraryEdition & {
      files: LibraryFile[];
      volumes: LibraryVolume[];
      metadataItems: LibraryMetadata[];
    }>;
  };
  sourceHints: Array<Pick<ImportTask, 'sourcePath' | 'originalName' | 'origin'>>;
};

export interface MetadataProvider {
  name: SuggestionSource;
  detect(context: OrganizeContext): Promise<PipelineSuggestion[]>;
}

export interface DuplicateProvider {
  name: string;
  detect(context: OrganizeContext): Promise<PipelineDuplicate[]>;
}

export interface RuleProvider {
  name: string;
  apply(context: OrganizeContext): Promise<PipelineSuggestion[]>;
}

const suggestionPriority: Record<SuggestionSource, number> = {
  embedded: 80,
  filename: 70,
  aggregation: 60,
  rule: 50,
  external: 30,
  ai: 10
};

const EXTERNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AI_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BANGUMI_USER_AGENT = 'ShukuStarship/0.1 (https://github.com/GMD170629/shuku-starship)';
const DEFAULT_DOUBAN_BASE_URL = 'https://book.douban.com';
const DEFAULT_DOUBAN_USER_AGENT = 'ShukuStarship/0.1 (+https://github.com/GMD170629/shuku-starship)';
const DOUBAN_CRAWLER_CACHE_VERSION = 'v2';
const CACHE_QUERY_KEY_MAX_LENGTH = 180;

function normalizeKey(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\s_\-.[\]()（）【】《》:：,，!！?？"'“”‘’]+/g, '')
    .trim();
}

function cleanTitlePart(value: string) {
  return value
    .replace(/\[[^\]]+\]|【[^】]+】|\([^)]*(?:汉化|掃圖|扫图|高清|完结|全彩)[^)]*\)/gi, ' ')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bracketedFolderMetadata(value: string) {
  const normalized = value.replace(/\s+/g, '');
  const parts = Array.from(normalized.matchAll(/\[([^\]]+)\]/g)).map((match) => cleanTitlePart(match[1])).filter(Boolean);
  if (parts.length !== 2 || parts.join('').length !== normalized.length - parts.length * 2) return null;
  return { title: parts[0], author: parts[1] };
}

function usableParentTitle(parent: string) {
  if (!parent || ['.', '/', 'books', 'library', 'comics', 'comic', 'manga', '漫画'].includes(parent.toLowerCase())) return null;
  return parent;
}

function usableParentAuthor(parent: string) {
  const metadata = bracketedFolderMetadata(parent);
  return metadata?.author ?? null;
}

function isManagedStoragePath(filePath: string) {
  const normalized = filePath.replaceAll('\\', '/');
  return /\/storage\/library\/[a-z0-9]{2}\//i.test(normalized) || /\/app\/storage\/library\/[a-z0-9]{2}\//i.test(normalized);
}

function trustedSourcePath(context: OrganizeContext) {
  const hinted = context.sourceHints.find((hint) => hint.sourcePath && !isManagedStoragePath(hint.sourcePath));
  if (hinted) return { path: hinted.sourcePath, originalName: hinted.originalName ?? undefined };
  const firstFile = context.work.editions.flatMap((edition) => edition.files).find((file) => !isManagedStoragePath(file.path));
  return firstFile ? { path: firstFile.path, originalName: undefined } : null;
}

function trustedMetadataPath(context: OrganizeContext) {
  const source = trustedSourcePath(context);
  if (!source) return null;
  return source.originalName ? join(dirname(source.path), source.originalName) : source.path;
}

function parseJson(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function coerceBoolean(value: string | null | undefined) {
  return value === 'true' || value === '1' || value === 'on';
}

async function systemSettings(keys: string[]) {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function metadataRefreshProvidersFromSettings(settings: Record<string, string | null | undefined>): RefreshProvider[] {
  const providers: RefreshProvider[] = [];
  if (coerceBoolean(settings['metadata.external.enabled'])) providers.push('external');
  if (coerceBoolean(settings['metadata.ai.enabled'])) providers.push('ai');
  return providers;
}

export function metadataRefreshProvidersForImport(providers: RefreshProvider[], options: { includeExternal?: boolean } = {}) {
  return providers.filter((provider) => options.includeExternal !== false || provider !== 'external');
}

export async function enabledMetadataRefreshProviders() {
  const settings = await systemSettings(['metadata.external.enabled', 'metadata.ai.enabled']);
  return metadataRefreshProvidersFromSettings(settings);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const first = value.map((item) => String(item).trim()).find(Boolean);
      if (first) return first;
    }
  }
  return null;
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : String((item as Record<string, unknown>).name ?? item)).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，;/]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function extractYear(value: unknown) {
  const match = String(value ?? '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstUrl(...values: unknown[]) {
  const value = firstString(...values);
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function doubanAbstractParts(value: unknown) {
  return firstString(value)?.split('/').map((part) => part.trim()).filter(Boolean) ?? [];
}

function doubanPublisherFromAbstract(value: unknown) {
  const parts = doubanAbstractParts(value);
  // 豆瓣搜索摘要通常是：作者 / 译者? / 出版社 / 出版日期 / 定价
  if (parts.length >= 5) return parts[parts.length - 3];
  if (parts.length >= 4) return parts[1];
  return null;
}

async function fetchJson(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function cachedJson(provider: string, queryKey: string, ttlMs: number, loader: () => Promise<unknown>) {
  const now = new Date();
  const cacheKey = safeCacheQueryKey(queryKey);
  const cached = await prisma.externalMetadataCache.findUnique({ where: { provider_queryKey: { provider, queryKey: cacheKey } } });
  if (cached && (!cached.expiresAt || cached.expiresAt > now)) return { value: parseJson(cached.rawJson), cacheHit: true };
  const value = await loader();
  await prisma.externalMetadataCache.upsert({
    where: { provider_queryKey: { provider, queryKey: cacheKey } },
    create: { provider, queryKey: cacheKey, rawJson: JSON.stringify(value), expiresAt: new Date(Date.now() + ttlMs) },
    update: { rawJson: JSON.stringify(value), expiresAt: new Date(Date.now() + ttlMs) }
  });
  return { value, cacheHit: false };
}

export function safeCacheQueryKey(queryKey: string) {
  if (queryKey.length <= CACHE_QUERY_KEY_MAX_LENGTH) return queryKey;
  const prefix = queryKey.slice(0, 48).replace(/[^a-zA-Z0-9:_./-]/g, '_');
  const digest = createHash('sha256').update(queryKey).digest('hex');
  return `${prefix}:sha256:${digest}`;
}

function stringifyValue(value: unknown) {
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown) {
  if (Array.isArray(left) || Array.isArray(right)) return normalizeKey((left as unknown[] | undefined)?.join(',') ?? left) === normalizeKey((right as unknown[] | undefined)?.join(',') ?? right);
  return normalizeKey(left) === normalizeKey(right);
}

function strictTitleKey(value: unknown) {
  return normalizeKey(String(value ?? '').normalize('NFKC'));
}

export function externalTitleMatchesWork(work: Pick<LibraryWork, 'title' | 'seriesName'>, value: unknown) {
  const candidate = strictTitleKey(value);
  if (!candidate) return false;
  return [work.title, work.seriesName].some((item) => strictTitleKey(item) === candidate);
}

function workValue(work: LibraryWork, field: SuggestionField) {
  if (field === 'tags') return parseJson(work.tags) ?? [];
  return work[field as keyof LibraryWork];
}

function makeSuggestion(context: OrganizeContext, field: SuggestionField, suggestedValue: unknown, source: SuggestionSource, confidence: number, reason: string): PipelineSuggestion | null {
  if (suggestedValue === null || suggestedValue === undefined || suggestedValue === '') return null;
  const currentValue = workValue(context.work, field);
  if (sameValue(currentValue, suggestedValue)) return null;
  return { field, currentValue, suggestedValue, source, confidence, reason };
}

export function parseMetadataFromFileName(filePath: string) {
  const rawBase = basename(filePath, extname(filePath)).replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
  const base = cleanTitlePart(rawBase);
  const rawParent = basename(dirname(filePath));
  const bracketParent = bracketedFolderMetadata(rawParent);
  const parent = bracketParent?.title ?? cleanTitlePart(rawParent);
  const withoutYear = base.replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
  const rawWithoutYear = rawBase.replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
  const year = Number(/\b(19\d{2}|20\d{2})\b/.exec(base)?.[1] ?? /\b(19\d{2}|20\d{2})\b/.exec(parent)?.[1]);
  const pureVolumePatterns = [
    /^(?:vol\.?|volume)\s*(\d+(?:\.\d+)?)$/i,
    /^v\s*(\d+(?:\.\d+)?)$/i,
    /^(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|冊|册|集)$/i
  ];
  const volumePatterns = [
    /^(.+?)\s*[\(（［\[]\s*(\d+(?:\.\d+)?)\s*[\)）］\]]\s*$/i,
    /^(.+?)\s*(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|冊|册|集)\s*$/i,
    /^(.+?)\s*(?:vol\.?|volume)\s*(\d+(?:\.\d+)?)\s*$/i,
    /^(.+?)\s+v(\d+(?:\.\d+)?)\s*$/i
  ];
  const volumeMatch = volumePatterns.map((pattern) => pattern.exec(withoutYear)).find(Boolean);
  const pureVolumeMatch = pureVolumePatterns.map((pattern) => pattern.exec(withoutYear)).find(Boolean);
  const pureVolumeParent = pureVolumeMatch ? usableParentTitle(parent) : null;
  const dashAuthorTitle = /^(.+?)\s+-\s+(.+)$/.exec(rawWithoutYear);
  const bracketAuthorTitle = /^(.+?)\s+[《<](.+?)[》>]$/.exec(rawWithoutYear);
  const author = dashAuthorTitle?.[2]
    ? cleanTitlePart(dashAuthorTitle[2].replace(/^(?:（[^）]+）|\([^)]*\))\s*/, ''))
    : bracketAuthorTitle?.[1]
      ? cleanTitlePart(bracketAuthorTitle[1].replace(/^(?:（[^）]+）|\([^)]*\))\s*/, ''))
      : pureVolumeMatch ? (bracketParent?.author ?? usableParentAuthor(rawParent)) : null;
  const title = dashAuthorTitle?.[1]
    ? cleanTitlePart(dashAuthorTitle[1])
    : bracketAuthorTitle?.[2]
      ? cleanTitlePart(bracketAuthorTitle[2])
      : cleanTitlePart(pureVolumeParent ?? volumeMatch?.[1] ?? withoutYear);
  const seriesName = cleanTitlePart(pureVolumeParent ?? volumeMatch?.[1] ?? usableParentTitle(parent) ?? '');
  const seriesIndex = Number(pureVolumeMatch?.[1] ?? volumeMatch?.[2]);
  return {
    title,
    author,
    seriesName: seriesName || null,
    seriesIndex: Number.isFinite(seriesIndex) ? seriesIndex : null,
    publishedYear: Number.isFinite(year) ? year : null
  };
}

export const filenameProvider: MetadataProvider = {
  name: 'filename',
  async detect(context) {
    const sourcePath = trustedMetadataPath(context);
    if (!sourcePath) return [];
    const parsed = parseMetadataFromFileName(sourcePath);
    return [
      makeSuggestion(context, 'title', parsed.seriesName && parsed.seriesIndex ? parsed.seriesName : parsed.title, 'filename', 0.72, '从文件名识别标题或系列名'),
      makeSuggestion(context, 'author', parsed.author, 'filename', 0.66, '从“标题 - 作者”文件名识别作者'),
      makeSuggestion(context, 'seriesName', parsed.seriesName, 'filename', 0.82, '从文件名或父目录识别系列名'),
      makeSuggestion(context, 'seriesIndex', parsed.seriesIndex, 'filename', 0.86, '从卷号标记识别卷号'),
      makeSuggestion(context, 'publishedYear', parsed.publishedYear, 'filename', 0.68, '从文件名或父目录识别出版年')
    ].filter((item): item is PipelineSuggestion => Boolean(item));
  }
};

export const embeddedMetadataProvider: MetadataProvider = {
  name: 'embedded',
  async detect(context) {
    const suggestions: Array<PipelineSuggestion | null> = [];
    for (const edition of context.work.editions) {
      if (edition.publishedAt) {
        const year = Number(/\b(19\d{2}|20\d{2})\b/.exec(edition.publishedAt)?.[1]);
        suggestions.push(makeSuggestion(context, 'publishedYear', Number.isFinite(year) ? year : null, 'embedded', 0.86, '从内嵌出版日期识别年份'));
      }
      if (edition.description) suggestions.push(makeSuggestion(context, 'description', edition.description, 'embedded', 0.82, '从内嵌元数据读取简介'));
      for (const item of edition.metadataItems) {
        const raw = parseJson(item.rawJson) as Record<string, unknown> | null;
        if (!raw) continue;
        const dcTitle = Array.isArray(raw['dc:title']) ? raw['dc:title'][0] : null;
        const dcCreator = Array.isArray(raw['dc:creator']) ? raw['dc:creator'][0] : null;
        const dcSubjects = Array.isArray(raw['dc:subject']) ? raw['dc:subject'] : null;
        const comicInfo = raw.comicInfo as Record<string, unknown> | undefined;
        suggestions.push(makeSuggestion(context, 'title', dcTitle ?? comicInfo?.Title, 'embedded', 0.9, '从 EPUB/ComicInfo 内嵌标题读取'));
        suggestions.push(makeSuggestion(context, 'author', dcCreator ?? comicInfo?.Writer ?? comicInfo?.Penciller, 'embedded', 0.9, '从 EPUB/ComicInfo 内嵌作者读取'));
        suggestions.push(makeSuggestion(context, 'seriesName', comicInfo?.Series, 'embedded', 0.92, '从 ComicInfo 系列字段读取'));
        suggestions.push(makeSuggestion(context, 'seriesIndex', Number(comicInfo?.Volume), 'embedded', 0.92, '从 ComicInfo 卷号字段读取'));
        suggestions.push(makeSuggestion(context, 'tags', dcSubjects, 'embedded', 0.75, '从 EPUB subject 字段读取标签'));
      }
    }
    return suggestions.filter((item): item is PipelineSuggestion => {
      if (!item) return false;
      return !(typeof item.suggestedValue === 'number' && !Number.isFinite(item.suggestedValue));
    });
  }
};

export const aggregationProvider: MetadataProvider = {
  name: 'aggregation',
  async detect(context) {
    const suggestions: Array<PipelineSuggestion | null> = [];
    const parsedTags = parseJson(context.work.tags);
    if (!Array.isArray(parsedTags) || parsedTags.length === 0) {
      if (context.work.workType === 'COMIC') suggestions.push(makeSuggestion(context, 'tags', ['comic'], 'aggregation', 0.6, '按读物类型补充基础标签'));
      if (context.work.workType === 'EPUB') suggestions.push(makeSuggestion(context, 'tags', ['epub'], 'aggregation', 0.6, '按读物类型补充基础标签'));
    }
    return suggestions.filter((item): item is PipelineSuggestion => Boolean(item));
  }
};

export const externalMetadataProvider: MetadataProvider = { name: 'external', async detect() { return []; } };
export const aiMetadataProvider: MetadataProvider = { name: 'ai', async detect() { return []; } };
export const customRuleProvider: RuleProvider = { name: 'custom-rule', async apply() { return []; } };

export const duplicateProvider: DuplicateProvider = {
  name: 'duplicate',
  async detect(context) {
    const files = context.work.editions.flatMap((edition) => edition.files);
    const hashes = new Set(files.map((file) => file.fullHash).filter(Boolean));
    const size = files.reduce((total, file) => total + BigInt(file.sizeBytes), BigInt(0));
    const candidates = await prisma.libraryWork.findMany({
      where: { id: { not: context.work.id }, hidden: false },
      take: 500,
      orderBy: { updatedAt: 'desc' },
      include: { editions: { where: { hidden: false }, include: { files: true, volumes: true } } }
    });
    const results: PipelineDuplicate[] = [];
    for (const other of candidates) {
      const otherFiles = other.editions.flatMap((edition) => edition.files);
      const otherHashes = new Set(otherFiles.map((file) => file.fullHash).filter(Boolean));
      const reasons: string[] = [];
      if ([...hashes].some((hash) => otherHashes.has(hash))) reasons.push('文件哈希相同');
      if (normalizeKey(context.work.title) && normalizeKey(context.work.title) === normalizeKey(other.title)) reasons.push('标题高度相似');
      if (normalizeKey(context.work.author) && normalizeKey(context.work.author) === normalizeKey(other.author) && normalizeKey(context.work.title) === normalizeKey(other.title)) reasons.push('作者与标题一致');
      if (context.work.seriesName && other.seriesName && normalizeKey(context.work.seriesName) === normalizeKey(other.seriesName) && context.work.seriesIndex === other.seriesIndex) reasons.push('系列名与卷号一致');
      const otherSize = otherFiles.reduce((total, file) => total + BigInt(file.sizeBytes), BigInt(0));
      if (size > BigInt(0) && size === otherSize) reasons.push('文件大小相同');
      if (!reasons.length) continue;
      const confidence = reasons.includes('文件哈希相同') ? 1 : reasons.includes('作者与标题一致') ? 0.84 : reasons.includes('系列名与卷号一致') ? 0.82 : 0.62;
      const suggestedAction: DuplicateAction = reasons.includes('文件哈希相同')
        ? 'HIDE_DUPLICATE'
        : context.work.workType === other.workType && normalizeKey(context.work.title) === normalizeKey(other.title)
          ? 'MERGE_AS_VERSION'
          : 'KEEP_SEPARATE';
      results.push({ targetWorkId: other.id, reasons, confidence, suggestedAction });
    }
    return results;
  }
};

async function buildContext(workId: string, importTaskId?: string | null): Promise<OrganizeContext | null> {
  const [work, importTasks] = await Promise.all([
    prisma.libraryWork.findUnique({
    where: { id: workId },
    include: {
      editions: {
        where: { hidden: false },
        orderBy: [{ primary: 'desc' }, { createdAt: 'asc' }],
        include: {
          files: { orderBy: { sortOrder: 'asc' } },
          volumes: { orderBy: { sortOrder: 'asc' } },
          metadataItems: { orderBy: { createdAt: 'desc' } }
        }
      }
    }
    }),
    prisma.importTask.findMany({
      where: importTaskId ? { id: importTaskId, workId } : { workId },
      select: { sourcePath: true, originalName: true, origin: true },
      orderBy: { createdAt: 'desc' },
      take: 8
    })
  ]);
  return work ? { work, sourceHints: importTasks } : null;
}

function dedupeSuggestions(suggestions: PipelineSuggestion[]) {
  const byField = new Map<string, PipelineSuggestion>();
  for (const suggestion of suggestions) {
    const existing = byField.get(suggestion.field);
    const score = suggestion.confidence * 100 + suggestionPriority[suggestion.source];
    const existingScore = existing ? existing.confidence * 100 + suggestionPriority[existing.source] : -1;
    if (!existing || score > existingScore) byField.set(suggestion.field, suggestion);
  }
  return [...byField.values()].sort((left, right) => right.confidence - left.confidence || suggestionPriority[right.source] - suggestionPriority[left.source]);
}

export async function detectOrganizeSuggestions(workId: string, importTaskId?: string | null) {
  const context = await buildContext(workId, importTaskId);
  if (!context) return null;
  const metadataProviders = [embeddedMetadataProvider, filenameProvider, aggregationProvider];
  const suggestions = dedupeSuggestions((await Promise.all(metadataProviders.map((provider) => provider.detect(context)))).flat().concat(await customRuleProvider.apply(context)));
  const duplicates = await duplicateProvider.detect(context);
  return { context, suggestions, duplicates };
}

export function contextSearchTitle(context: OrganizeContext) {
  const sourcePath = trustedMetadataPath(context);
  const parsed = sourcePath ? parseMetadataFromFileName(sourcePath) : null;
  if (context.work.workType === 'COMIC') return parsed?.title || context.work.title;
  return context.work.seriesName ?? parsed?.seriesName ?? context.work.title;
}

function contextAuthor(context: OrganizeContext) {
  const sourcePath = trustedMetadataPath(context);
  const parsed = sourcePath ? parseMetadataFromFileName(sourcePath) : null;
  return context.work.author ?? parsed?.author ?? null;
}

function makeExternalSuggestion(context: OrganizeContext, field: SuggestionField, suggestedValue: unknown, confidence: number, reason: string) {
  return makeSuggestion(context, field, suggestedValue, 'external', confidence, reason);
}

function metadataSourceForCandidate(source: MetadataLookupSource): SuggestionSource {
  return source === 'ai' ? 'ai' : 'external';
}

function candidateValue(candidate: MetadataCandidate, field: SuggestionField) {
  return candidate[field];
}

function normalizeMetadataCandidate(candidate: MetadataCandidate): MetadataCandidate {
  const raw = candidate.raw && typeof candidate.raw === 'object' ? candidate.raw as Record<string, unknown> : {};
  return {
    ...candidate,
    publisher: firstString(candidate.publisher, raw.publisher, doubanPublisherFromAbstract(raw.abstract)),
    coverUrl: firstUrl(candidate.coverUrl, raw.coverUrl, raw.cover_url, raw.image)
  };
}

function normalizeMetadataCandidates(candidates: MetadataCandidate[]) {
  return candidates.map(normalizeMetadataCandidate);
}

export function candidateToSuggestions(context: OrganizeContext, candidate: MetadataCandidate, fields: SuggestionField[]) {
  const source = metadataSourceForCandidate(candidate.source);
  return fields
    .map((field) => makeSuggestion(context, field, candidateValue(candidate, field), source, candidate.confidence, `${candidate.source} 候选：用户选择应用 ${field}`))
    .filter((item): item is PipelineSuggestion => Boolean(item));
}

function doubanCandidates(payload: unknown, confidence: number): MetadataCandidate[] {
  const raw = payload as Record<string, unknown>;
  const books = Array.isArray(raw.books) ? raw.books : Array.isArray(raw.items) ? raw.items : Array.isArray(payload) ? payload as unknown[] : raw.title || raw.id ? [raw] : [];
  return books.map((item, index) => {
    const book = item as Record<string, unknown>;
    const pubdate = firstString(book.pubdate, book.publishedAt, book.date);
    const tags = stringArray(book.tags).length ? stringArray(book.tags) : stringArray(book.tag);
    const images = book.images && typeof book.images === 'object' ? book.images as Record<string, unknown> : {};
    return {
      id: String(book.id ?? book.isbn13 ?? book.isbn10 ?? book.url ?? `douban-${index}`),
      source: 'douban' as const,
      title: firstString(book.title, book.subtitle),
      author: firstString(book.author, book.authors),
      publisher: firstString(book.publisher),
      description: firstString(book.summary, book.description),
      tags,
      publishedYear: extractYear(pubdate),
      coverUrl: firstUrl(book.image, book.cover, book.coverUrl, images.large, images.medium, images.small),
      confidence,
      raw: book
    };
  }).filter((candidate) => candidate.title || candidate.author || candidate.description);
}

function decodeHtml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string) {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html: string, property: string) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta\\s+(?:property|name)=["']${escaped}["']\\s+content=["']([^"']*)["']`, 'i');
  const match = pattern.exec(html);
  return match ? decodeHtml(match[1]).trim() : null;
}

function parseJsonLdBook(html: string) {
  const match = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseDoubanInfoBlock(html: string) {
  const match = /<div\s+id=["']info["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const block = match?.[1] ?? '';
  const text = stripHtml(block).replace(/\s*(作者|出版社|出版年|ISBN|页数|定价|装帧|副标题|原作名|译者):\s*/g, '\n$1: ');
  const fields: Record<string, string> = {};
  for (const line of text.split('\n').map((item) => item.trim()).filter(Boolean)) {
    const fieldMatch = /^(作者|出版社|出版年|ISBN|页数|定价|装帧|副标题|原作名|译者):\s*(.+)$/.exec(line);
    if (fieldMatch) fields[fieldMatch[1]] = fieldMatch[2].trim();
  }
  return fields;
}

function parseDoubanIntro(html: string) {
  const heading = html.search(/<h2>\s*<span>内容简介<\/span>/);
  if (heading < 0) return metaContent(html, 'og:description');
  const rest = html.slice(heading);
  const introMatch = /<div class=["']intro["'][^>]*>([\s\S]*?)<\/div>/i.exec(rest);
  if (!introMatch) return metaContent(html, 'og:description');
  return stripHtml(introMatch[1]).replace(/\s+/g, '\n').trim();
}

export function parseDoubanSubjectHtml(html: string, fallback: Partial<MetadataCandidate> = {}): MetadataCandidate | null {
  const jsonLd = parseJsonLdBook(html);
  const info = parseDoubanInfoBlock(html);
  const authorValue = jsonLd?.author;
  const authors = Array.isArray(authorValue)
    ? authorValue.map((item) => firstString((item as Record<string, unknown>).name)).filter(Boolean)
    : stringArray(authorValue);
  const url = firstString(jsonLd?.url, jsonLd?.sameAs, metaContent(html, 'og:url'), fallback.id);
  const id = /\/subject\/(\d+)\//.exec(url ?? '')?.[1] ?? String(fallback.id ?? `douban-${normalizeKey(url ?? jsonLd?.name ?? fallback.title)}`);
  const pubdate = firstString(info['出版年'], fallback.raw && (fallback.raw as Record<string, unknown>).pubdate);
  const title = firstString(jsonLd?.name, metaContent(html, 'og:title'), fallback.title);
  const author = authors[0] ?? firstString(info['作者'], fallback.author);
  const description = firstString(parseDoubanIntro(html), fallback.description);
  const tags = stringArray(fallback.tags);
  const isbn = firstString(jsonLd?.isbn, metaContent(html, 'book:isbn'), info.ISBN);
  const publisher = firstString(info['出版社'], fallback.publisher);
  const coverUrl = firstUrl(metaContent(html, 'og:image'), fallback.coverUrl);
  if (!title && !author && !description) return null;
  return {
    id,
    source: 'douban',
    title,
    author,
    publisher,
    description,
    tags,
    publishedYear: extractYear(pubdate),
    coverUrl,
    confidence: fallback.confidence ?? 0.78,
    raw: { ...(fallback.raw as Record<string, unknown> | undefined), id, url, isbn, pubdate, publisher, coverUrl }
  };
}

export function parseDoubanSearchHtml(html: string, confidence: number): MetadataCandidate[] {
  const marker = 'window.__DATA__ = ';
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const dataStart = start + marker.length;
  const dataEnd = html.indexOf(';', dataStart);
  if (dataEnd < 0) return [];
  try {
    const raw = JSON.parse(html.slice(dataStart, dataEnd)) as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? raw.items : [];
    return items
      .map((item) => item as Record<string, unknown>)
      .filter((item) => item.tpl_name === 'search_subject' && firstString(item.url)?.includes('/subject/'))
      .map((item) => {
        const abstractParts = doubanAbstractParts(item.abstract);
        const coverUrl = firstUrl(item.cover_url);
        return {
          id: String(item.id ?? /\/subject\/(\d+)\//.exec(firstString(item.url) ?? '')?.[1] ?? `douban-${normalizeKey(item.title)}`),
          source: 'douban' as const,
          title: firstString(item.title),
          author: abstractParts[0] ?? null,
          publisher: doubanPublisherFromAbstract(item.abstract),
          description: firstString(item.abstract_2),
          tags: [],
          publishedYear: extractYear(firstString(item.abstract)),
          coverUrl,
          confidence,
          raw: { ...item, url: firstString(item.url), coverUrl }
        };
      })
      .filter((candidate) => candidate.title || candidate.author);
  } catch {
    return [];
  }
}

function doubanHeaders(settings: Record<string, string | null | undefined>) {
  return {
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'User-Agent': settings['metadata.douban.userAgent'] || DEFAULT_DOUBAN_USER_AGENT,
    Referer: DEFAULT_DOUBAN_BASE_URL
  };
}

function doubanBaseUrl(settings: Record<string, string | null | undefined>) {
  return (settings['metadata.douban.baseUrl']?.trim() || DEFAULT_DOUBAN_BASE_URL).replace(/\/+$/, '');
}

async function fetchDoubanSubject(baseUrl: string, subjectUrl: string, headers: Record<string, string>, fallback: Partial<MetadataCandidate>) {
  const url = subjectUrl.startsWith('http') ? subjectUrl : `${baseUrl}${subjectUrl.startsWith('/') ? '' : '/'}${subjectUrl}`;
  const cache = await cachedJson('douban-crawler', `${DOUBAN_CRAWLER_CACHE_VERSION}:subject:${url}`, EXTERNAL_TTL_MS, async () => {
    const html = await fetchText(url, { headers });
    return parseDoubanSubjectHtml(html, fallback);
  });
  const candidate = cache.value as MetadataCandidate | null;
  return { candidate: candidate ? normalizeMetadataCandidate(candidate) : null, cacheHit: cache.cacheHit };
}

async function searchDoubanCrawlerCandidates(settings: Record<string, string | null | undefined>, queryText: string, confidence: number) {
  const baseUrl = doubanBaseUrl(settings);
  const headers = doubanHeaders(settings);
  const subjectMatch = /(?:book\.douban\.com\/subject\/)?(\d{4,})/.exec(queryText);
  if (subjectMatch && queryText.includes('/subject/')) {
    const subject = await fetchDoubanSubject(baseUrl, `/subject/${subjectMatch[1]}/`, headers, { confidence });
    return subject.candidate ? { candidates: [subject.candidate], cacheHit: subject.cacheHit } : { candidates: [], cacheHit: subject.cacheHit };
  }
  const query = new URLSearchParams({ search_text: queryText }).toString();
  const search = await cachedJson('douban-crawler', `${DOUBAN_CRAWLER_CACHE_VERSION}:search:${normalizeKey(queryText)}`, EXTERNAL_TTL_MS, async () => {
    const html = await fetchText(`${baseUrl}/subject_search?${query}`, { headers });
    return parseDoubanSearchHtml(html, confidence).slice(0, 8);
  });
  const candidates = Array.isArray(search.value) ? normalizeMetadataCandidates(search.value as MetadataCandidate[]) : [];
  return { candidates, cacheHit: search.cacheHit };
}

function doubanBookSuggestions(context: OrganizeContext, payload: unknown, confidence: number) {
  const book = doubanCandidates(payload, confidence)[0];
  if (!book) return [];
  return [
    makeExternalSuggestion(context, 'title', book.title, confidence, '外部数据源 · 豆瓣：匹配图书标题'),
    makeExternalSuggestion(context, 'author', book.author, confidence, '外部数据源 · 豆瓣：匹配作者'),
    makeExternalSuggestion(context, 'description', book.description, Math.min(confidence, 0.82), '外部数据源 · 豆瓣：补全简介'),
    makeExternalSuggestion(context, 'tags', book.tags, Math.min(confidence, 0.76), '外部数据源 · 豆瓣：补全标签'),
    makeExternalSuggestion(context, 'publishedYear', book.publishedYear, Math.min(confidence, 0.82), '外部数据源 · 豆瓣：补全出版年')
  ].filter((item): item is PipelineSuggestion => Boolean(item));
}

async function runDoubanProvider(context: OrganizeContext, options: ProviderRunOptions = {}) {
  const settings = await systemSettings(['metadata.external.enabled', 'metadata.douban.enabled', 'metadata.douban.mode', 'metadata.douban.baseUrl', 'metadata.douban.apiKey', 'metadata.douban.userAgent']);
  if (!options.force && (!coerceBoolean(settings['metadata.external.enabled']) || !coerceBoolean(settings['metadata.douban.enabled']))) return { suggestions: [], enabled: false, cacheHit: false, message: '豆瓣数据源未启用' };
  const edition = context.work.editions[0];
  const isbn = edition?.isbn ?? edition?.identifier ?? null;
  const title = contextSearchTitle(context);
  const author = contextAuthor(context);
  const mode = settings['metadata.douban.mode'] === 'api' ? 'api' : 'crawler';
  if (mode === 'crawler') {
    const query = isbn || [title, author].filter(Boolean).join(' ');
    const search = await searchDoubanCrawlerCandidates(settings, query, isbn ? 0.9 : author ? 0.8 : 0.7);
    const first = search.candidates[0];
    if (!first) return { suggestions: [], enabled: true, cacheHit: search.cacheHit, message: '豆瓣未找到匹配图书' };
    const subjectUrl = first.raw && typeof first.raw === 'object' ? firstString((first.raw as Record<string, unknown>).url) : null;
    const detail = subjectUrl ? await fetchDoubanSubject(doubanBaseUrl(settings), subjectUrl, doubanHeaders(settings), first) : { candidate: first, cacheHit: true };
    return { suggestions: doubanBookSuggestions(context, detail.candidate ?? first, detail.candidate?.confidence ?? first.confidence), enabled: true, cacheHit: search.cacheHit && detail.cacheHit };
  }
  const baseUrl = settings['metadata.douban.baseUrl']?.replace(/\/+$/, '');
  if (!baseUrl) return { suggestions: [], enabled: false, cacheHit: false, message: '豆瓣兼容 API 地址未配置' };
  const apiKey = settings['metadata.douban.apiKey'];
  const params = new URLSearchParams();
  if (apiKey) params.set('apikey', apiKey);
  let endpoint = '';
  let confidence = 0.68;
  if (isbn) {
    endpoint = `/v2/book/isbn/${encodeURIComponent(isbn)}`;
    confidence = 0.92;
  } else {
    endpoint = '/v2/book/search';
    params.set('q', [title, author].filter(Boolean).join(' '));
    params.set('count', '3');
    confidence = author ? 0.82 : 0.68;
  }
  const query = params.toString();
  const url = `${baseUrl}${endpoint}${query ? `?${query}` : ''}`;
  const cache = await cachedJson('douban', `${endpoint}?${query}`, EXTERNAL_TTL_MS, () => fetchJson(url, { headers: { Accept: 'application/json' } }));
  return { suggestions: doubanBookSuggestions(context, cache.value, confidence), enabled: true, cacheHit: cache.cacheHit };
}

async function searchDoubanCandidates(_context: OrganizeContext, queryText: string) {
  const settings = await systemSettings(['metadata.douban.mode', 'metadata.douban.baseUrl', 'metadata.douban.apiKey', 'metadata.douban.userAgent']);
  const mode = settings['metadata.douban.mode'] === 'api' ? 'api' : 'crawler';
  if (mode === 'crawler') {
    const search = await searchDoubanCrawlerCandidates(settings, queryText, 0.78);
    const enriched = await Promise.all(search.candidates.slice(0, 3).map((candidate) => resolveDoubanCrawlerCandidate(candidate, settings)));
    return [...enriched, ...search.candidates.slice(3)];
  }
  const baseUrl = settings['metadata.douban.baseUrl']?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('豆瓣兼容 API 地址未配置');
  const params = new URLSearchParams({ q: queryText, count: '8' });
  if (settings['metadata.douban.apiKey']) params.set('apikey', settings['metadata.douban.apiKey']);
  const query = params.toString();
  const cache = await cachedJson('douban', `/v2/book/search?${query}`, EXTERNAL_TTL_MS, () => fetchJson(`${baseUrl}/v2/book/search?${query}`, { headers: { Accept: 'application/json' } }));
  return normalizeMetadataCandidates(doubanCandidates(cache.value, 0.78));
}

async function resolveDoubanCrawlerCandidate(candidate: MetadataCandidate, settings?: Record<string, string | null | undefined>) {
  const doubanSettings = settings ?? await systemSettings(['metadata.douban.mode', 'metadata.douban.baseUrl', 'metadata.douban.userAgent']);
  if (doubanSettings['metadata.douban.mode'] === 'api') return candidate;
  const raw = candidate.raw && typeof candidate.raw === 'object' ? candidate.raw as Record<string, unknown> : {};
  const subjectUrl = firstString(raw.url, /^\d+$/.test(candidate.id) ? `/subject/${candidate.id}/` : null);
  if (!subjectUrl) return candidate;
  const detail = await fetchDoubanSubject(doubanBaseUrl(doubanSettings), subjectUrl, doubanHeaders(doubanSettings), candidate);
  return detail.candidate ?? normalizeMetadataCandidate(candidate);
}

function bangumiCandidates(payload: unknown, confidence: number): MetadataCandidate[] {
  const raw = payload as Record<string, unknown>;
  const data = Array.isArray(raw.data) ? raw.data : Array.isArray(payload) ? payload as unknown[] : raw.name || raw.id ? [raw] : [];
  return data.map((item, index) => {
    const subject = item as Record<string, unknown>;
    const imageMap = subject.images && typeof subject.images === 'object' ? subject.images as Record<string, unknown> : {};
    const tags = Array.isArray(subject.tags) ? subject.tags.map((tag) => typeof tag === 'string' ? tag : (tag as Record<string, unknown>).name).filter(Boolean).map(String) : [];
    const infobox = Array.isArray(subject.infobox) ? subject.infobox as Array<Record<string, unknown>> : [];
    const authors = infobox.filter((entry) => /作者|作画|原作/.test(String(entry.key))).flatMap((entry) => stringArray(entry.value));
    const publisher = infobox.find((entry) => /出版社|发行|发售|厂牌|连载杂志/.test(String(entry.key)))?.value;
    const volume = infobox.find((entry) => /册数|卷数|话数/.test(String(entry.key)))?.value;
    const date = firstString(subject.date, subject.air_date);
    return {
      id: String(subject.id ?? subject.url ?? `bangumi-${index}`),
      source: 'bangumi' as const,
      title: firstString(subject.name_cn, subject.name),
      author: authors[0] ?? null,
      publisher: firstString(publisher),
      description: firstString(subject.summary),
      tags: tags.slice(0, 8),
      seriesName: firstString(subject.name_cn, subject.name),
      seriesIndex: numberOrNull(volume),
      publishedYear: extractYear(date),
      coverUrl: firstUrl(imageMap.large, imageMap.common, imageMap.medium, imageMap.grid, subject.image),
      confidence,
      raw: subject
    };
  }).filter((candidate) => candidate.title || candidate.description);
}

function bangumiSubjectSuggestions(context: OrganizeContext, payload: unknown, confidence: number) {
  const subject = bangumiCandidates(payload, confidence)[0];
  if (!subject) return [];
  return [
    makeExternalSuggestion(context, 'title', subject.title, confidence, '外部数据源 · Bangumi：匹配漫画条目'),
    makeExternalSuggestion(context, 'author', subject.author, Math.min(confidence, 0.78), '外部数据源 · Bangumi：补全作者/原作'),
    makeExternalSuggestion(context, 'description', subject.description, Math.min(confidence, 0.8), '外部数据源 · Bangumi：补全简介'),
    makeExternalSuggestion(context, 'tags', subject.tags, Math.min(confidence, 0.72), '外部数据源 · Bangumi：补全标签'),
    makeExternalSuggestion(context, 'seriesName', subject.seriesName, Math.min(confidence, 0.82), '外部数据源 · Bangumi：补全系列名'),
    makeExternalSuggestion(context, 'publishedYear', subject.publishedYear, Math.min(confidence, 0.78), '外部数据源 · Bangumi：补全出版年')
  ].filter((item): item is PipelineSuggestion => Boolean(item));
}

async function runBangumiProvider(context: OrganizeContext, options: ProviderRunOptions = {}) {
  const settings = await systemSettings(['metadata.external.enabled', 'metadata.bangumi.enabled', 'metadata.bangumi.accessToken', 'metadata.bangumi.userAgent']);
  if (!options.force && (!coerceBoolean(settings['metadata.external.enabled']) || !coerceBoolean(settings['metadata.bangumi.enabled']))) return { suggestions: [], enabled: false, cacheHit: false, message: 'Bangumi 数据源未启用' };
  const userAgent = settings['metadata.bangumi.userAgent'] || DEFAULT_BANGUMI_USER_AGENT;
  if (!userAgent) return { suggestions: [], enabled: false, cacheHit: false, message: 'Bangumi User-Agent 未配置' };
  const title = contextSearchTitle(context);
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent };
  if (settings['metadata.bangumi.accessToken']) headers.Authorization = `Bearer ${settings['metadata.bangumi.accessToken']}`;
  const cache = await cachedJson('bangumi', `search:${normalizeKey(title)}`, EXTERNAL_TTL_MS, () =>
    fetchJson('https://api.bgm.tv/v0/search/subjects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ keyword: title, sort: 'match', filter: { type: [1] } })
    })
  );
  return { suggestions: bangumiSubjectSuggestions(context, cache.value, 0.82), enabled: true, cacheHit: cache.cacheHit };
}

async function searchBangumiCandidates(_context: OrganizeContext, queryText: string) {
  const settings = await systemSettings(['metadata.bangumi.accessToken', 'metadata.bangumi.userAgent']);
  const userAgent = settings['metadata.bangumi.userAgent'] || DEFAULT_BANGUMI_USER_AGENT;
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent };
  if (settings['metadata.bangumi.accessToken']) headers.Authorization = `Bearer ${settings['metadata.bangumi.accessToken']}`;
  const cache = await cachedJson('bangumi', `search:${normalizeKey(queryText)}`, EXTERNAL_TTL_MS, () =>
    fetchJson('https://api.bgm.tv/v0/search/subjects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ keyword: queryText, sort: 'match', filter: { type: [1] } })
    })
  );
  return bangumiCandidates(cache.value, 0.82);
}

function localMetadataSummary(context: OrganizeContext) {
  const files = context.work.editions.flatMap((edition) => edition.files).slice(0, 8);
  const metadata = context.work.editions.flatMap((edition) => edition.metadataItems).slice(0, 4).map((item) => parseJson(item.rawJson));
  return {
    title: context.work.title,
    author: context.work.author,
    seriesName: context.work.seriesName,
    seriesIndex: context.work.seriesIndex,
    publishedYear: context.work.publishedYear,
    tags: parseJson(context.work.tags) ?? [],
    fileNames: files.map((file) => basename(file.path)),
    parentPaths: [...new Set(files.map((file) => dirname(file.path)))],
    embeddedMetadata: metadata
  };
}

function aiSuggestions(context: OrganizeContext, payload: unknown) {
  const raw = payload as Record<string, unknown>;
  const message = Array.isArray(raw.choices) ? (raw.choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined : undefined;
  const content = typeof message?.content === 'string' ? message.content : JSON.stringify(raw);
  const parsed = parseJson(content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()) as Record<string, unknown> | null;
  const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  return suggestions.map((item) => {
    const suggestion = item as Record<string, unknown>;
    const field = suggestion.field as SuggestionField;
    if (!['title', 'author', 'description', 'tags', 'seriesName', 'seriesIndex', 'publishedYear'].includes(field)) return null;
    const confidence = normalizeAiSuggestionConfidence(suggestion.confidence);
    return makeSuggestion(context, field, suggestion.value, 'ai', confidence, `AI 识别：${String(suggestion.reason ?? '根据本地元数据摘要推断')}`);
  }).filter((item): item is PipelineSuggestion => Boolean(item));
}

function aiCandidates(payload: unknown): MetadataCandidate[] {
  const raw = payload as Record<string, unknown>;
  const message = Array.isArray(raw.choices) ? (raw.choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined : undefined;
  const content = typeof message?.content === 'string' ? message.content : JSON.stringify(raw);
  const parsed = parseJson(content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()) as Record<string, unknown> | null;
  const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : Array.isArray(parsed?.suggestions) ? [{ suggestions: parsed.suggestions }] : [];
  return candidates.map((item, index) => {
    const candidate = item as Record<string, unknown>;
    const suggestions = Array.isArray(candidate.suggestions) ? candidate.suggestions as Array<Record<string, unknown>> : [];
    const byField = Object.fromEntries(suggestions.map((suggestion) => [String(suggestion.field), suggestion.value]));
    const confidence = normalizeAiSuggestionConfidence(candidate.confidence ?? Math.max(...suggestions.map((suggestion) => Number(suggestion.confidence ?? 0.6)), 0.6));
    return {
      id: String(candidate.id ?? `ai-${index}`),
      source: 'ai' as const,
      title: firstString(candidate.title, byField.title),
      author: firstString(candidate.author, byField.author),
      publisher: firstString(candidate.publisher, byField.publisher),
      description: firstString(candidate.description, byField.description),
      tags: stringArray(candidate.tags ?? byField.tags),
      seriesName: firstString(candidate.seriesName, byField.seriesName),
      seriesIndex: numberOrNull(candidate.seriesIndex ?? byField.seriesIndex),
      publishedYear: extractYear(candidate.publishedYear ?? byField.publishedYear),
      coverUrl: firstUrl(candidate.coverUrl, byField.coverUrl),
      confidence,
      raw: candidate
    };
  }).filter((candidate) => candidate.title || candidate.author || candidate.description || (candidate.tags?.length ?? 0) > 0);
}

export function normalizeAiSuggestionConfidence(confidence: unknown) {
  return Math.min(0.74, Math.max(0, Number(confidence ?? 0.6)));
}

async function runAiProvider(context: OrganizeContext, options: ProviderRunOptions = {}) {
  const settings = await systemSettings(['metadata.ai.enabled', 'metadata.ai.baseUrl', 'metadata.ai.apiKey', 'metadata.ai.model']);
  if (!options.force && !coerceBoolean(settings['metadata.ai.enabled'])) return { suggestions: [], enabled: false, cacheHit: false, message: 'AI 元数据识别未启用' };
  const baseUrl = settings['metadata.ai.baseUrl']?.replace(/\/+$/, '');
  const model = settings['metadata.ai.model'];
  if (!baseUrl || !settings['metadata.ai.apiKey'] || !model) return { suggestions: [], enabled: false, cacheHit: false, message: 'AI 接口地址、模型或 API Key 未配置' };
  const summary = localMetadataSummary(context);
  const cache = await cachedJson('ai', `ai:${normalizeKey(JSON.stringify(summary))}:${model}`, AI_TTL_MS, () =>
    fetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${settings['metadata.ai.apiKey']}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是图书元数据整理助手。只返回 JSON，格式为 {"suggestions":[{"field":"title|author|description|tags|seriesName|seriesIndex|publishedYear","value":...,"confidence":0-1,"reason":"..."}]}。不要编造不确定信息。' },
          { role: 'user', content: JSON.stringify(summary) }
        ]
      })
    })
  );
  return { suggestions: aiSuggestions(context, cache.value), enabled: true, cacheHit: cache.cacheHit };
}

async function searchAiCandidates(context: OrganizeContext, queryText: string) {
  const settings = await systemSettings(['metadata.ai.baseUrl', 'metadata.ai.apiKey', 'metadata.ai.model']);
  const baseUrl = settings['metadata.ai.baseUrl']?.replace(/\/+$/, '');
  const model = settings['metadata.ai.model'];
  if (!baseUrl || !settings['metadata.ai.apiKey'] || !model) throw new Error('AI 接口地址、模型或 API Key 未配置');
  const summary = { ...localMetadataSummary(context), query: queryText };
  const cache = await cachedJson('ai', `lookup:${normalizeKey(JSON.stringify(summary))}:${model}`, AI_TTL_MS, () =>
    fetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${settings['metadata.ai.apiKey']}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是图书元数据整理助手。只返回 JSON，格式为 {"candidates":[{"title":"","author":"","publisher":"","description":"","tags":[],"seriesName":"","seriesIndex":null,"publishedYear":null,"coverUrl":null,"confidence":0-1}]}。可以返回 1 到 3 个候选；coverUrl 只有在本地摘要或可靠上下文明确提供图片 URL 时才填写，不要编造不确定信息。' },
          { role: 'user', content: JSON.stringify(summary) }
        ]
      })
    })
  );
  return aiCandidates(cache.value);
}

export async function searchMetadataCandidates(options: { workId: string; source: MetadataLookupSource; query: string }) {
  const context = await buildContext(options.workId);
  if (!context) throw new Error('读物不存在');
  const queryText = options.query.trim();
  if (!queryText) throw new Error('请输入查询文本');
  if (options.source === 'bangumi') return searchBangumiCandidates(context, queryText);
  if (options.source === 'douban') return searchDoubanCandidates(context, queryText);
  return searchAiCandidates(context, queryText);
}

async function addSuggestionsToJob(jobId: string, suggestions: PipelineSuggestion[]) {
  const existing = await prisma.metadataSuggestion.findMany({ where: { jobId, status: 'PENDING' }, select: { field: true, source: true, suggestedValue: true } });
  const seen = new Set(existing.map((item) => `${item.field}:${item.source}:${item.suggestedValue}`));
  const create = suggestions
    .map((suggestion) => ({
      field: suggestion.field,
      currentValue: stringifyValue(suggestion.currentValue),
      suggestedValue: stringifyValue(suggestion.suggestedValue),
      source: suggestion.source,
      confidence: suggestion.confidence,
      reason: suggestion.reason
    }))
    .filter((item) => {
      const key = `${item.field}:${item.source}:${item.suggestedValue}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (create.length) await prisma.metadataSuggestion.createMany({ data: create.map((item) => ({ jobId, ...item })) });
  return create.length;
}

export async function refreshOrganizeMetadataProviders(jobId: string, providers: RefreshProvider[], options: ProviderRunOptions = {}) {
  const job = await prisma.organizeJob.findUnique({ where: { id: jobId }, select: { id: true, workId: true, importTaskId: true } });
  if (!job) throw new Error('整理任务不存在');
  const context = await buildContext(job.workId, job.importTaskId);
  if (!context) throw new Error('读物不存在');
  const results: ProviderRunResult[] = [];
  for (const provider of [...new Set(providers)]) {
    try {
      const run = provider === 'external'
        ? context.work.workType === 'COMIC' ? await runBangumiProvider(context, options) : await runDoubanProvider(context, options)
        : await runAiProvider(context, options);
      const added = run.enabled ? await addSuggestionsToJob(job.id, run.suggestions) : 0;
      results.push({ provider, enabled: run.enabled, added, cacheHit: run.cacheHit, message: run.message });
    } catch (error) {
      results.push({ provider, enabled: true, added: 0, cacheHit: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const added = results.reduce((total, result) => total + result.added, 0);
  if (added > 0) {
    await prisma.organizeJob.update({ where: { id: job.id }, data: { status: 'REVIEWING', summary: `新增 ${added} 条外部/AI 元数据建议` } });
    await prisma.libraryWork.update({ where: { id: job.workId }, data: { organizeStatus: 'REVIEWING', organized: false } });
  }
  return { added, results };
}

export async function refreshAndApplyImportMetadata(jobId: string, options: { includeExternal?: boolean } = {}) {
  const providers = metadataRefreshProvidersForImport(await enabledMetadataRefreshProviders(), options);
  if (providers.length === 0) {
    return { providers, refresh: null, applied: 0, enabled: false };
  }
  const refresh = await refreshOrganizeMetadataProviders(jobId, providers);
  const apply = await applyMetadataSuggestions({ jobId, highConfidenceOnly: true });
  return { providers, refresh, applied: apply.applied, enabled: true };
}

export function metadataQualityFor(suggestions: PipelineSuggestion[], duplicates: PipelineDuplicate[]) {
  const penalty = suggestions.filter((item) => item.confidence >= 0.7).length * 12 + duplicates.length * 10;
  return Math.max(0, Math.min(100, 100 - penalty));
}

export async function createOrRefreshOrganizeJob(options: { workId: string; editionId?: string | null; importTaskId?: string | null }) {
  const detected = await detectOrganizeSuggestions(options.workId, options.importTaskId);
  if (!detected) return null;
  const issues = [
    ...detected.suggestions.map((suggestion) => `SUGGEST_${suggestion.field.toUpperCase()}`),
    ...(detected.duplicates.length ? ['DUPLICATE'] : []),
    ...(!detected.context.work.organized ? ['NEW_IMPORT'] : [])
  ];
  const quality = metadataQualityFor(detected.suggestions, detected.duplicates);
  const status = issues.length ? 'REVIEWING' : 'APPLIED';
  const job = await prisma.$transaction(async (tx) => {
    await tx.organizeJob.updateMany({ where: { workId: options.workId, status: { in: ['PENDING', 'REVIEWING'] } }, data: { status: 'DISMISSED' } });
    const created = await tx.organizeJob.create({
      data: {
        workId: options.workId,
        editionId: options.editionId ?? detected.context.work.primaryEditionId ?? detected.context.work.editions[0]?.id ?? null,
        importTaskId: options.importTaskId ?? null,
        status,
        issueCodes: JSON.stringify([...new Set(issues)]),
        summary: detected.suggestions.length || detected.duplicates.length ? `发现 ${detected.suggestions.length} 条元数据建议，${detected.duplicates.length} 条重复/版本候选` : '未发现需要整理的问题',
        suggestions: {
          create: detected.suggestions.map((suggestion) => ({
            field: suggestion.field,
            currentValue: stringifyValue(suggestion.currentValue),
            suggestedValue: stringifyValue(suggestion.suggestedValue),
            source: suggestion.source,
            confidence: suggestion.confidence,
            reason: suggestion.reason
          }))
        },
        duplicates: {
          create: detected.duplicates.map((duplicate) => ({
            targetWorkId: duplicate.targetWorkId,
            reasons: JSON.stringify(duplicate.reasons),
            confidence: duplicate.confidence,
            suggestedAction: duplicate.suggestedAction
          }))
        }
      }
    });
    await tx.libraryWork.update({
      where: { id: options.workId },
      data: {
        metadataQuality: quality,
        organizeStatus: status,
        organized: status === 'APPLIED' ? true : detected.context.work.organized
      }
    });
    return created;
  });
  return job;
}

export async function applyMetadataSuggestions(options: { jobId: string; suggestionIds?: string[]; highConfidenceOnly?: boolean; markOrganized?: boolean; dismiss?: boolean }) {
  const job = await prisma.organizeJob.findUnique({
    where: { id: options.jobId },
    include: { suggestions: true, work: { select: { title: true, seriesName: true } } }
  });
  if (!job) throw new Error('整理任务不存在');
  if (options.dismiss) {
    await prisma.$transaction([
      prisma.organizeJob.update({ where: { id: job.id }, data: { status: 'DISMISSED' } }),
      prisma.libraryWork.update({ where: { id: job.workId }, data: { organizeStatus: 'DISMISSED' } })
    ]);
    return { applied: 0, dismissed: true };
  }
  const allowed = new Set(options.suggestionIds ?? []);
  const selected = job.suggestions.filter((suggestion) =>
    suggestion.status === 'PENDING'
    && (options.suggestionIds ? allowed.has(suggestion.id) : true)
    && (!options.highConfidenceOnly || suggestion.confidence >= 0.8)
    && (!options.highConfidenceOnly || suggestion.field !== 'title' || suggestion.source !== 'external' || externalTitleMatchesWork(job.work, parseJson(suggestion.suggestedValue) ?? suggestion.suggestedValue))
  );
  const data: Prisma.LibraryWorkUpdateInput = {};
  for (const suggestion of selected) {
    const value = parseJson(suggestion.suggestedValue) ?? suggestion.suggestedValue;
    if (suggestion.field === 'title' && typeof value === 'string' && value.trim()) {
      data.title = value.trim();
      data.normalizedTitle = normalizeKey(value);
    }
    if (suggestion.field === 'author' && typeof value === 'string') {
      data.author = value.trim() || null;
      data.normalizedAuthor = normalizeKey(value) || null;
    }
    if (suggestion.field === 'description' && typeof value === 'string') data.description = value;
    if (suggestion.field === 'tags' && Array.isArray(value)) data.tags = JSON.stringify([...new Set(value.map(String).map((tag) => tag.trim()).filter(Boolean))]);
    if (suggestion.field === 'seriesName' && typeof value === 'string') data.seriesName = value.trim() || null;
    if (suggestion.field === 'seriesIndex' && typeof value === 'number' && Number.isFinite(value)) data.seriesIndex = value;
    if (suggestion.field === 'publishedYear' && typeof value === 'number' && Number.isInteger(value)) data.publishedYear = value;
  }
  if (options.markOrganized) {
    data.organized = true;
    data.organizeStatus = 'APPLIED';
  }
  await prisma.$transaction([
    ...(Object.keys(data).length ? [prisma.libraryWork.update({ where: { id: job.workId }, data })] : []),
    ...(selected.length ? [prisma.metadataSuggestion.updateMany({ where: { id: { in: selected.map((suggestion) => suggestion.id) } }, data: { status: 'APPLIED' } })] : []),
    prisma.organizeJob.update({ where: { id: job.id }, data: { status: options.markOrganized ? 'APPLIED' : job.status } })
  ]);
  return { applied: selected.length, dismissed: false };
}

const suggestionFieldSet = new Set<SuggestionField>(['title', 'author', 'description', 'tags', 'seriesName', 'seriesIndex', 'publishedYear']);
const metadataApplyFieldSet = new Set<MetadataApplyField>(['title', 'author', 'description', 'tags', 'seriesName', 'seriesIndex', 'publishedYear', 'publisher', 'coverUrl']);

function isSuggestionField(field: string): field is SuggestionField {
  return suggestionFieldSet.has(field as SuggestionField);
}

function isMetadataApplyField(field: string): field is MetadataApplyField {
  return metadataApplyFieldSet.has(field as MetadataApplyField);
}

function candidatePatch(candidate: MetadataCandidate, fields: SuggestionField[]): Prisma.LibraryWorkUpdateInput {
  const allowed = new Set(fields);
  const data: Prisma.LibraryWorkUpdateInput = {};
  if (allowed.has('title') && typeof candidate.title === 'string' && candidate.title.trim()) {
    data.title = candidate.title.trim();
    data.normalizedTitle = normalizeKey(candidate.title);
  }
  if (allowed.has('author') && typeof candidate.author === 'string') {
    data.author = candidate.author.trim() || null;
    data.normalizedAuthor = normalizeKey(candidate.author) || null;
  }
  if (allowed.has('description') && typeof candidate.description === 'string') data.description = candidate.description;
  if (allowed.has('tags') && Array.isArray(candidate.tags)) data.tags = JSON.stringify([...new Set(candidate.tags.map(String).map((tag) => tag.trim()).filter(Boolean))]);
  if (allowed.has('seriesName') && typeof candidate.seriesName === 'string') data.seriesName = candidate.seriesName.trim() || null;
  if (allowed.has('seriesIndex') && typeof candidate.seriesIndex === 'number' && Number.isFinite(candidate.seriesIndex)) data.seriesIndex = candidate.seriesIndex;
  if (allowed.has('publishedYear') && typeof candidate.publishedYear === 'number' && Number.isInteger(candidate.publishedYear)) data.publishedYear = candidate.publishedYear;
  return data;
}

function coverExtension(contentType: string | null, url: string) {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  const ext = extname(new URL(url).pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '.jpg';
}

async function downloadCandidateCover(workId: string, coverUrl: string) {
  const url = firstUrl(coverUrl);
  if (!url) throw new Error('候选封面地址无效');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { headers: { Accept: 'image/*' }, signal: controller.signal });
    if (!response.ok) throw new Error(`封面下载失败：HTTP ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.toLowerCase().startsWith('image/')) throw new Error('候选封面不是图片');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('候选封面为空');
    if (bytes.length > 8 * 1024 * 1024) throw new Error('候选封面超过 8MB');
    const storageRoot = process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage');
    const coverRoot = join(storageRoot, 'covers', 'external');
    await mkdir(coverRoot, { recursive: true });
    const digest = createHash('sha256').update(`${workId}:${url}`).digest('hex').slice(0, 12);
    const coverPath = join(coverRoot, `${workId}-${digest}${coverExtension(contentType, url)}`);
    await writeFile(coverPath, bytes);
    return coverPath;
  } finally {
    clearTimeout(timeout);
  }
}

export async function applyMetadataCandidate(options: { workId: string; source: MetadataLookupSource; candidate: MetadataCandidate; fields: MetadataApplyField[] }) {
  const context = await buildContext(options.workId);
  if (!context) throw new Error('读物不存在');
  const selectedApplyFields = [...new Set(options.fields.map(String).filter(isMetadataApplyField))];
  const selectedFields = selectedApplyFields.filter(isSuggestionField);
  if (selectedApplyFields.length === 0) throw new Error('请选择要应用的字段');
  const candidate = options.source === 'douban'
    ? await resolveDoubanCrawlerCandidate({ ...options.candidate, source: options.source })
    : { ...options.candidate, source: options.source };
  const data = candidatePatch(candidate, selectedFields);
  const editionData: Prisma.LibraryEditionUpdateInput = {};
  if (selectedApplyFields.includes('publisher') && typeof candidate.publisher === 'string' && candidate.publisher.trim()) {
    editionData.publisher = candidate.publisher.trim();
  }
  if (selectedApplyFields.includes('coverUrl') && typeof candidate.coverUrl === 'string' && candidate.coverUrl.trim()) {
    data.coverPath = await downloadCandidateCover(options.workId, candidate.coverUrl);
    data.coverStatus = 'READY';
  }
  if (Object.keys(data).length === 0 && Object.keys(editionData).length === 0) throw new Error('所选字段没有可应用的值');
  const suggestions = candidateToSuggestions(context, candidate, selectedFields);
  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) await tx.libraryWork.update({ where: { id: options.workId }, data: { ...data, organized: true, organizeStatus: 'APPLIED' } });
    else await tx.libraryWork.update({ where: { id: options.workId }, data: { organized: true, organizeStatus: 'APPLIED' } });
    const primaryEdition = context.work.editions.find((edition) => edition.id === context.work.primaryEditionId) ?? context.work.editions.find((edition) => edition.primary) ?? context.work.editions[0] ?? null;
    if (primaryEdition && Object.keys(editionData).length) {
      await tx.libraryEdition.update({ where: { id: primaryEdition.id }, data: editionData });
    }
    const job = await tx.organizeJob.findFirst({
      where: { workId: options.workId, status: { in: ['PENDING', 'REVIEWING'] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true }
    });
    if (job && suggestions.length) {
      await tx.metadataSuggestion.createMany({
        data: suggestions.map((suggestion) => ({
          jobId: job.id,
          field: suggestion.field,
          currentValue: stringifyValue(suggestion.currentValue),
          suggestedValue: stringifyValue(suggestion.suggestedValue),
          source: suggestion.source,
          confidence: suggestion.confidence,
          reason: suggestion.reason,
          status: 'APPLIED'
        }))
      });
      await tx.metadataSuggestion.updateMany({
        where: { jobId: job.id, status: 'PENDING', field: { in: selectedFields } },
        data: { status: 'DISMISSED' }
      });
    }
  });
  return { applied: selectedApplyFields.length };
}

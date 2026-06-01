import { basename, dirname, extname } from 'node:path';
import { prisma } from '@shuku/database';
import type { LibraryEdition, LibraryFile, LibraryMetadata, LibraryVolume, LibraryWork, Prisma } from '@prisma/client';

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

function parseJson(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringifyValue(value: unknown) {
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown) {
  if (Array.isArray(left) || Array.isArray(right)) return normalizeKey((left as unknown[] | undefined)?.join(',') ?? left) === normalizeKey((right as unknown[] | undefined)?.join(',') ?? right);
  return normalizeKey(left) === normalizeKey(right);
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
  const parent = cleanTitlePart(basename(dirname(filePath)));
  const withoutYear = base.replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
  const rawWithoutYear = rawBase.replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
  const year = Number(/\b(19\d{2}|20\d{2})\b/.exec(base)?.[1] ?? /\b(19\d{2}|20\d{2})\b/.exec(parent)?.[1]);
  const volumePatterns = [
    /^(.+?)\s*[\(（［\[]\s*(\d+(?:\.\d+)?)\s*[\)）］\]]\s*$/i,
    /^(.+?)\s*(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|冊|册|集)\s*$/i,
    /^(.+?)\s*(?:vol\.?|volume)\s*(\d+(?:\.\d+)?)\s*$/i,
    /^(.+?)\s+v(\d+(?:\.\d+)?)\s*$/i
  ];
  const volumeMatch = volumePatterns.map((pattern) => pattern.exec(withoutYear)).find(Boolean);
  const dashAuthorTitle = /^(.+?)\s+-\s+(.+)$/.exec(rawWithoutYear);
  const bracketAuthorTitle = /^(.+?)\s+[《<](.+?)[》>]$/.exec(rawWithoutYear);
  const author = dashAuthorTitle?.[2]
    ? cleanTitlePart(dashAuthorTitle[2].replace(/^(?:（[^）]+）|\([^)]*\))\s*/, ''))
    : bracketAuthorTitle?.[1]
      ? cleanTitlePart(bracketAuthorTitle[1].replace(/^(?:（[^）]+）|\([^)]*\))\s*/, ''))
      : null;
  const title = dashAuthorTitle?.[1]
    ? cleanTitlePart(dashAuthorTitle[1])
    : bracketAuthorTitle?.[2]
      ? cleanTitlePart(bracketAuthorTitle[2])
      : cleanTitlePart(volumeMatch?.[1] ?? withoutYear);
  const seriesName = cleanTitlePart(volumeMatch?.[1] ?? (parent && normalizeKey(parent) !== normalizeKey('library') ? parent : ''));
  const seriesIndex = Number(volumeMatch?.[2]);
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
    const firstFile = context.work.editions.flatMap((edition) => edition.files)[0];
    if (!firstFile) return [];
    const parsed = parseMetadataFromFileName(firstFile.path);
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

async function buildContext(workId: string): Promise<OrganizeContext | null> {
  const work = await prisma.libraryWork.findUnique({
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
  });
  return work ? { work } : null;
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

export async function detectOrganizeSuggestions(workId: string) {
  const context = await buildContext(workId);
  if (!context) return null;
  const metadataProviders = [embeddedMetadataProvider, filenameProvider, aggregationProvider, externalMetadataProvider, aiMetadataProvider];
  const suggestions = dedupeSuggestions((await Promise.all(metadataProviders.map((provider) => provider.detect(context)))).flat().concat(await customRuleProvider.apply(context)));
  const duplicates = await duplicateProvider.detect(context);
  return { context, suggestions, duplicates };
}

export function metadataQualityFor(suggestions: PipelineSuggestion[], duplicates: PipelineDuplicate[]) {
  const penalty = suggestions.filter((item) => item.confidence >= 0.7).length * 12 + duplicates.length * 10;
  return Math.max(0, Math.min(100, 100 - penalty));
}

export async function createOrRefreshOrganizeJob(options: { workId: string; editionId?: string | null; importTaskId?: string | null }) {
  const detected = await detectOrganizeSuggestions(options.workId);
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
  const job = await prisma.organizeJob.findUnique({ where: { id: options.jobId }, include: { suggestions: true } });
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

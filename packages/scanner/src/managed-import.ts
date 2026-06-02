import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, posix, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { prisma } from '@shuku/database';
import { Prisma } from '@prisma/client';
import type { BookOrigin } from '@prisma/client';
import { createOrRefreshOrganizeJob, refreshAndApplyImportMetadata } from './organize-pipeline.js';

const STORAGE_ROOT = resolve(process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage'));
const LIBRARY_STORAGE_ROOT = process.env.LIBRARY_STORAGE_ROOT ?? join(STORAGE_ROOT, 'library');
const BOOK_ASSET_ROOT = join(STORAGE_ROOT, 'books');

const DEFAULT_MAX_EPUB_SIZE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

function envByteLimit(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_EPUB_SIZE_BYTES = envByteLimit('EPUB_MAX_SIZE_BYTES', DEFAULT_MAX_EPUB_SIZE_BYTES);
const MAX_ARCHIVE_SIZE_BYTES = envByteLimit('COMIC_MAX_ARCHIVE_SIZE_BYTES', DEFAULT_MAX_ARCHIVE_SIZE_BYTES);
const MAX_ENTRIES = Number(process.env.IMPORT_MAX_ENTRIES ?? 10000);
const MAX_IMAGE_COUNT = Number(process.env.COMIC_MAX_IMAGE_COUNT ?? 5000);
const MAX_SINGLE_IMAGE_BYTES = Number(process.env.COMIC_MAX_SINGLE_IMAGE_BYTES ?? 80 * 1024 * 1024);
const XML_MAX_BYTES = Number(process.env.COMIC_INFO_MAX_BYTES ?? 2 * 1024 * 1024);

const supportedExts = new Set(['.epub', '.cbz', '.zip']);
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

export function formatImportByteLimit(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${units[unitIndex]}`;
}

export function importFileSizeLimitBytesForExt(ext: string) {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  if (normalized === '.epub') return MAX_EPUB_SIZE_BYTES;
  if (normalized === '.cbz' || normalized === '.zip') return MAX_ARCHIVE_SIZE_BYTES;
  return null;
}

export type ImportManagedBookOptions = {
  sourceFilePath: string;
  originalName?: string;
  origin: BookOrigin;
  monitorFolderId?: string | null;
  importTaskId?: string | null;
};

export type ImportManagedBookResult = {
  bookId: string;
  workId?: string;
  editionId?: string;
  volumeId?: string | null;
  title: string;
  type: 'ebook' | 'comic';
  format: 'epub' | 'cbz' | 'zip';
  totalUnits: number;
  coverUrl?: string | null;
  importStatus: 'completed' | 'failed';
  duplicate: boolean;
  merged?: boolean;
  mergeReason?: string;
  refreshExternalMetadata?: boolean;
};

type ParsedEpubChapter = { title: string; href: string; idref?: string; mediaType?: string; sortOrder: number };
type EpubManifestItem = { id?: string; href?: string; mediaType?: string; properties?: string };
type EpubSpineRef = { idref?: string };
type ParsedEpubMetadata = {
  title: string;
  author: string;
  language?: string | null;
  identifier?: string | null;
  isbn?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  description?: string | null;
  subjects?: string[];
  coverPath?: string | null;
  coverMediaType?: string | null;
  chapterCount: number;
  chapters: ParsedEpubChapter[];
  opfPath: string;
  rawMetadata: Record<string, unknown>;
};

type ParsedComicPage = { index: number; title: string; entryPath: string; mediaType: string; size?: number };
type ParsedComicInfo = {
  title?: string;
  series?: string;
  volume?: number;
  summary?: string;
  writer?: string;
  penciller?: string;
  publisher?: string;
  tags?: string[];
  coverImageIndex?: number;
  raw: Record<string, unknown>;
};
type ParsedComicArchive = {
  title: string;
  author: string;
  description?: string | null;
  format: 'cbz' | 'zip';
  pageCount: number;
  coverEntryPath: string;
  pages: ParsedComicPage[];
  comicInfo?: ParsedComicInfo | null;
  rawMetadata: Record<string, unknown>;
};

export type ParsedComicVolume = {
  seriesName: string;
  seriesIndex: number;
  title: string;
  author?: string | null;
} | null;

function storageUrl(path: string) {
  const relative = path.startsWith(STORAGE_ROOT) ? path.slice(STORAGE_ROOT.length).replace(/^\/+/, '') : path;
  return `/storage/${relative}`;
}

function entryMimeType(name: string) {
  const ext = extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function titleFromFile(filePath: string, originalName?: string) {
  const source = originalName || basename(filePath);
  return basename(source, extname(source)).replaceAll('_', ' ').replaceAll('-', ' ').trim() || basename(source);
}

function cleanComicTitlePart(value: string) {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bracketedComicFolderMetadata(value: string) {
  const parts = Array.from(value.matchAll(/\[([^\]]+)\]/g)).map((match) => cleanComicTitlePart(match[1])).filter(Boolean);
  if (parts.length !== 2 || parts.join('').length !== value.replace(/\s+/g, '').length - parts.length * 2) return null;
  return { title: parts[0], author: parts[1] };
}

function comicParentTitle(filePath: string) {
  const parent = cleanComicTitlePart(basename(dirname(filePath)));
  if (!parent || ['.', '/', 'books', 'library', 'comics', 'comic', 'manga', '漫画'].includes(parent.toLowerCase())) return null;
  return bracketedComicFolderMetadata(parent)?.title ?? parent;
}

function comicParentAuthor(filePath: string) {
  const parent = cleanComicTitlePart(basename(dirname(filePath)));
  if (!parent || ['.', '/', 'books', 'library', 'comics', 'comic', 'manga', '漫画'].includes(parent.toLowerCase())) return null;
  return bracketedComicFolderMetadata(parent)?.author ?? null;
}

export function parseComicVolumeFromName(filePath: string, originalName?: string): ParsedComicVolume {
  const source = originalName || basename(filePath);
  const baseTitle = basename(source, extname(source));
  const parent = comicParentTitle(filePath);
  const pureVolumePatterns = [
    /^(?:vol\.?|volume)\s*(\d+(?:\.\d+)?)$/i,
    /^v\s*(\d+(?:\.\d+)?)$/i,
    /^(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|冊|册|集)$/i
  ];
  for (const pattern of pureVolumePatterns) {
    const match = pattern.exec(baseTitle.trim());
    const seriesIndex = Number(match?.[1]);
    if (parent && Number.isFinite(seriesIndex)) {
      const author = comicParentAuthor(filePath);
      return author ? { seriesName: parent, seriesIndex, title: `${parent} (${seriesIndex})`, author } : { seriesName: parent, seriesIndex, title: `${parent} (${seriesIndex})` };
    }
  }

  const candidates = [
    /^(.+?)\s*[\(（［\[]\s*(\d+(?:\.\d+)?)\s*[\)）］\]]\s*$/i,
    /^(.+?)\s*(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|冊|册|集)\s*$/i,
    /^(.+?)\s*(?:vol\.?|volume)\s*(\d+(?:\.\d+)?)\s*$/i,
    /^(.+?)\s+v(\d+(?:\.\d+)?)\s*$/i
  ];

  for (const pattern of candidates) {
    const match = pattern.exec(baseTitle);
    const series = cleanComicTitlePart(match?.[1] ?? '');
    const seriesIndex = Number(match?.[2]);
    if (series && Number.isFinite(seriesIndex)) {
      return { seriesName: series, seriesIndex, title: `${series} (${seriesIndex})` };
    }
  }

  return null;
}

function safeEntryName(name: string) {
  const normalized = normalize(name).replaceAll('\\', '/');
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) return null;
  const parsed = posix.normalize(name.replaceAll('\\', '/'));
  if (parsed.startsWith('../') || parsed === '..') return null;
  return parsed;
}

function isIgnoredEntry(name: string) {
  const parts = name.split('/');
  const last = parts.at(-1) ?? name;
  return parts.includes('__MACOSX') || last === '.DS_Store' || last === 'Thumbs.db' || last.startsWith('._') || parts.some((part) => part.startsWith('.') && part !== '.');
}

function isImageEntry(name: string) {
  return imageExts.has(extname(name).toLowerCase()) && !isIgnoredEntry(name);
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error: Error | null, zipFile?: yauzl.ZipFile) => {
      if (error || !zipFile) reject(error ?? new Error('ZIP 打开失败'));
      else resolveZip(zipFile);
    });
  });
}

function closeZip(zipFile: yauzl.ZipFile) {
  try {
    zipFile.close();
  } catch {
    // yauzl may have already closed the descriptor.
  }
}

async function readZipEntry(filePath: string, entryName: string): Promise<Buffer> {
  return new Promise((resolveBuffer, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (openError: Error | null, zipFile?: yauzl.ZipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('ZIP 打开失败'));
        return;
      }
      const fail = (error: Error) => {
        closeZip(zipFile);
        reject(error);
      };
      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError: Error | null, stream?: Readable) => {
          if (streamError || !stream) return fail(streamError ?? new Error('ZIP 条目读取失败'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.once('end', () => {
            closeZip(zipFile);
            resolveBuffer(Buffer.concat(chunks));
          });
          stream.once('error', fail);
        });
      });
      zipFile.once('end', () => fail(new Error('ZIP 条目不存在')));
      zipFile.once('error', fail);
      zipFile.readEntry();
    });
  });
}

async function readZipText(filePath: string, entryPath: string) {
  return (await readZipEntry(filePath, entryPath)).toString('utf8');
}

async function readZipTextOptional(filePath: string, entryPath: string) {
  try {
    return await readZipText(filePath, entryPath);
  } catch {
    return null;
  }
}

function decodeXmlText(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function textTag(xml: string, tag: string) {
  return Array.from(xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')))
    .map((match) => decodeXmlText(match[1]))
    .filter(Boolean);
}

function attrsFromTag(xml: string, name: string) {
  return Array.from(xml.matchAll(new RegExp(`<${name}\\b([^>]*)/?>(?:</${name}>)?`, 'gi'))).map((match) =>
    Object.fromEntries(Array.from(match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)).map((attr) => [attr[1], attr[2] ?? attr[3] ?? '']))
  );
}

function sanitizeDescription(value: string | null) {
  return value ? value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

function extractIsbn(ids: string[]) {
  for (const id of ids) {
    const match = id.replace(/[^0-9Xx]/g, '').match(/(?:97[89])?[0-9]{9}[0-9Xx]/);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

function splitHref(href: string) {
  const [pathPart, fragment] = href.split('#', 2);
  return { path: pathPart, fragment };
}

function normalizeEpubPath(path: string) {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function epubZipPath(opfPath: string, href: string) {
  return normalizeEpubPath(posix.join(posix.dirname(opfPath), splitHref(href).path));
}

function hrefRelativeToOpf(opfPath: string, sourceFilePath: string, href: string) {
  const { path, fragment } = splitHref(href);
  const absoluteHrefPath = normalizeEpubPath(posix.join(posix.dirname(sourceFilePath), path));
  const relative = normalizeEpubPath(posix.relative(posix.dirname(opfPath), absoluteHrefPath));
  return fragment ? `${relative}#${fragment}` : relative;
}

function isDefaultChapterTitle(value: string) {
  return /^第\s*\d+\s*章$/.test(value.trim());
}

function buildSpineChapters(manifestItems: EpubManifestItem[], spineRefs: EpubSpineRef[]) {
  const chapterMap = new Map(manifestItems.map((item) => [item.id, item]));
  return spineRefs
    .map((ref, index) => {
      const item = chapterMap.get(ref.idref);
      return { title: `第 ${index + 1} 章`, href: item?.href ?? '', idref: ref.idref, mediaType: item?.mediaType, sortOrder: index + 1 };
    })
    .filter((chapter) => chapter.href);
}

async function titleFromXhtml(epubPath: string, opfPath: string, href: string) {
  const markup = await readZipTextOptional(epubPath, epubZipPath(opfPath, href));
  if (!markup) return null;
  for (const tag of ['h1', 'h2', 'h3', 'title']) {
    const text = textTag(markup, tag)[0];
    if (text) return text;
  }
  return null;
}

async function buildHeadingFallbackChapters(epubPath: string, opfPath: string, manifestItems: EpubManifestItem[], spineRefs: EpubSpineRef[]) {
  const chapters = buildSpineChapters(manifestItems, spineRefs);
  return Promise.all(chapters.map(async (chapter) => ({
    ...chapter,
    title: await titleFromXhtml(epubPath, opfPath, chapter.href) ?? chapter.title
  })));
}

function manifestLookup(manifestItems: EpubManifestItem[]) {
  return new Map(manifestItems.filter((item) => item.href).map((item) => [normalizeEpubPath(item.href ?? ''), item]));
}

function chapterFromTocEntry(
  entry: { title: string; href: string },
  sortOrder: number,
  opfPath: string,
  tocFilePath: string,
  itemsByHref: Map<string, EpubManifestItem>
): ParsedEpubChapter | null {
  const href = hrefRelativeToOpf(opfPath, tocFilePath, entry.href);
  const baseHref = splitHref(href).path;
  const item = itemsByHref.get(normalizeEpubPath(baseHref));
  if (!href || !entry.title) return null;
  return {
    title: entry.title,
    href,
    idref: item?.id,
    mediaType: item?.mediaType,
    sortOrder
  };
}

function parseNcxChapters(ncxXml: string, opfPath: string, ncxPath: string, itemsByHref: Map<string, EpubManifestItem>) {
  const entries = Array.from(ncxXml.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/gi))
    .map((match) => {
      const block = match[0];
      const title = textTag(block, 'text')[0] ?? '';
      const src = attrsFromTag(block, 'content')[0]?.src ?? '';
      return { title, href: src };
    })
    .filter((entry) => entry.title && entry.href);
  return entries
    .map((entry, index) => chapterFromTocEntry(entry, index + 1, opfPath, ncxPath, itemsByHref))
    .filter((chapter): chapter is ParsedEpubChapter => Boolean(chapter));
}

function parseNavChapters(navXml: string, opfPath: string, navPath: string, itemsByHref: Map<string, EpubManifestItem>) {
  const navBlocks = Array.from(navXml.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi));
  const tocBlock = navBlocks.find((match) => /\b(?:epub:)?type\s*=\s*["'][^"']*\btoc\b/i.test(match[1]) || /\brole\s*=\s*["']doc-toc["']/i.test(match[1]))?.[2] ?? navBlocks[0]?.[2] ?? navXml;
  const entries = Array.from(tocBlock.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi))
    .map((match) => ({
      title: decodeXmlText(match[2]),
      href: attrsFromTag(`<a${match[1]}>`, 'a')[0]?.href ?? ''
    }))
    .filter((entry) => entry.title && entry.href);
  return entries
    .map((entry, index) => chapterFromTocEntry(entry, index + 1, opfPath, navPath, itemsByHref))
    .filter((chapter): chapter is ParsedEpubChapter => Boolean(chapter));
}

async function buildTocChapters(epubPath: string, opfPath: string, opfXml: string, manifestItems: EpubManifestItem[]) {
  const itemsByHref = manifestLookup(manifestItems);
  const spineAttrs = attrsFromTag(opfXml, 'spine')[0] ?? {};
  const ncxItem = manifestItems.find((item) => item.id === spineAttrs.toc) ?? manifestItems.find((item) => /ncx/i.test(String(item.mediaType ?? '')) || /\.ncx$/i.test(String(item.href ?? '')));
  if (ncxItem?.href) {
    const ncxPath = epubZipPath(opfPath, ncxItem.href);
    const ncxXml = await readZipTextOptional(epubPath, ncxPath);
    const chapters = ncxXml ? parseNcxChapters(ncxXml, opfPath, ncxPath, itemsByHref) : [];
    if (chapters.length) return chapters;
  }

  const navItem = manifestItems.find((item) => String(item.properties ?? '').split(/\s+/).includes('nav'));
  if (navItem?.href) {
    const navPath = epubZipPath(opfPath, navItem.href);
    const navXml = await readZipTextOptional(epubPath, navPath);
    const chapters = navXml ? parseNavChapters(navXml, opfPath, navPath, itemsByHref) : [];
    if (chapters.length) return chapters;
  }

  return [];
}

async function buildEpubChapters(epubPath: string, opfPath: string, opfXml: string, manifestItems: EpubManifestItem[], spineRefs: EpubSpineRef[]) {
  const tocChapters = await buildTocChapters(epubPath, opfPath, opfXml, manifestItems);
  if (tocChapters.length) return tocChapters;

  const headingChapters = await buildHeadingFallbackChapters(epubPath, opfPath, manifestItems, spineRefs);
  if (headingChapters.some((chapter) => !isDefaultChapterTitle(chapter.title))) return headingChapters;
  return buildSpineChapters(manifestItems, spineRefs);
}

export async function parseEpubMetadata(epubPath: string): Promise<ParsedEpubMetadata> {
  const fileStat = await stat(epubPath);
  if (fileStat.size > MAX_EPUB_SIZE_BYTES) throw new Error(`EPUB 文件过大：当前限制 ${formatImportByteLimit(MAX_EPUB_SIZE_BYTES)}，可通过 EPUB_MAX_SIZE_BYTES 调整`);
  await openZip(epubPath).then((zip) => zip.close());
  const containerXml = await readZipText(epubPath, 'META-INF/container.xml');
  const opfPath = /full-path="([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath) throw new Error('container.xml 缺少 rootfile full-path');
  const opfXml = await readZipText(epubPath, opfPath);
  const metadata = {
    'dc:title': textTag(opfXml, 'dc:title'),
    'dc:creator': textTag(opfXml, 'dc:creator'),
    'dc:identifier': textTag(opfXml, 'dc:identifier'),
    'dc:language': textTag(opfXml, 'dc:language'),
    'dc:publisher': textTag(opfXml, 'dc:publisher'),
    'dc:date': textTag(opfXml, 'dc:date'),
    'dc:description': textTag(opfXml, 'dc:description'),
    'dc:subject': textTag(opfXml, 'dc:subject'),
    meta: attrsFromTag(opfXml, 'meta')
  };
  const manifestItems = attrsFromTag(opfXml, 'item').map((item) => ({ id: item.id, href: item.href, mediaType: item['media-type'], properties: item.properties }));
  const spineRefs = attrsFromTag(opfXml, 'itemref').map((item) => ({ idref: item.idref }));
  const title = metadata['dc:title'][0] ?? titleFromFile(epubPath);
  const authors = metadata['dc:creator'].length ? metadata['dc:creator'] : ['未知作者'];
  const identifiers = metadata['dc:identifier'];
  const chapters = await buildEpubChapters(epubPath, opfPath, opfXml, manifestItems, spineRefs);
  const epub2CoverId = metadata.meta.find((item) => item.name === 'cover')?.content;
  const cover =
    manifestItems.find((item) => item.id === epub2CoverId) ??
    manifestItems.find((item) => String(item.properties ?? '').includes('cover-image')) ??
    manifestItems.find((item) => /image/.test(String(item.mediaType ?? '')) && /(cover|front|folder|封面)/i.test(String(item.href ?? '')));

  return {
    title,
    author: authors[0],
    language: metadata['dc:language'][0] ?? null,
    identifier: identifiers[0] ?? null,
    isbn: extractIsbn(identifiers),
    publisher: metadata['dc:publisher'][0] ?? null,
    publishedAt: metadata['dc:date'][0] ?? null,
    description: sanitizeDescription(metadata['dc:description'][0] ?? null),
    subjects: metadata['dc:subject'],
    coverPath: cover?.href ?? null,
    coverMediaType: cover?.mediaType ?? null,
    chapterCount: chapters.length,
    chapters,
    opfPath,
    rawMetadata: metadata
  };
}

function xmlText(xml: string, tag: string) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!match) return undefined;
  return match[1]
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim() || undefined;
}

function parseComicInfoXml(xmlInput: string): ParsedComicInfo {
  const xml = xmlInput.replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!ENTITY[\s\S]*?>/gi, '');
  const raw: Record<string, unknown> = {};
  for (const tag of ['Title', 'Series', 'Volume', 'Summary', 'Writer', 'Penciller', 'Publisher', 'Genre', 'Tags']) {
    const value = xmlText(xml, tag);
    if (value) raw[tag] = value;
  }
  const coverPage = Array.from(xml.matchAll(/<Page\b([^>]*)\/?>/gi))
    .map((match) => Object.fromEntries(Array.from(match[1].matchAll(/([\w:-]+)="([^"]*)"/g)).map((attr) => [attr[1], attr[2]])))
    .find((attrs) => /frontcover|cover/i.test(String(attrs.Type ?? attrs.type ?? '')));
  const coverImageIndex = coverPage?.Image ? Number(coverPage.Image) : undefined;
  if (Number.isFinite(coverImageIndex)) raw.coverImageIndex = coverImageIndex;
  return {
    title: xmlText(xml, 'Title'),
    series: xmlText(xml, 'Series'),
    volume: Number.isFinite(Number(xmlText(xml, 'Volume'))) ? Number(xmlText(xml, 'Volume')) : undefined,
    summary: xmlText(xml, 'Summary'),
    writer: xmlText(xml, 'Writer'),
    penciller: xmlText(xml, 'Penciller'),
    publisher: xmlText(xml, 'Publisher'),
    tags: (xmlText(xml, 'Tags') ?? xmlText(xml, 'Genre'))?.split(/[,，;]/).map((tag) => tag.trim()).filter(Boolean),
    coverImageIndex: Number.isFinite(coverImageIndex) ? coverImageIndex : undefined,
    raw
  };
}

async function listArchiveEntries(filePath: string) {
  const zipFile = await openZip(filePath);
  return new Promise<{ images: Array<{ name: string; uncompressedSize: number }>; comicInfoEntry?: { name: string; uncompressedSize: number } }>((resolveEntries, reject) => {
    const images: Array<{ name: string; uncompressedSize: number }> = [];
    let comicInfoEntry: { name: string; uncompressedSize: number } | undefined;
    let scanned = 0;
    zipFile.on('entry', (entry: yauzl.Entry) => {
      scanned += 1;
      if (scanned > MAX_ENTRIES) {
        closeZip(zipFile);
        reject(new Error(`压缩包文件数量超过限制（${MAX_ENTRIES}）`));
        return;
      }
      const safeName = safeEntryName(entry.fileName);
      if (safeName && !/\/$/.test(safeName)) {
        if (safeName.toLowerCase().endsWith('comicinfo.xml') && entry.uncompressedSize <= XML_MAX_BYTES) comicInfoEntry = { name: safeName, uncompressedSize: entry.uncompressedSize };
        else if (isImageEntry(safeName)) {
          if (entry.uncompressedSize > MAX_SINGLE_IMAGE_BYTES) {
            closeZip(zipFile);
            reject(new Error(`单张图片超过限制（${MAX_SINGLE_IMAGE_BYTES} bytes）：${safeName}`));
            return;
          }
          images.push({ name: safeName, uncompressedSize: entry.uncompressedSize });
        }
      }
      zipFile.readEntry();
    });
    zipFile.once('end', () => {
      closeZip(zipFile);
      resolveEntries({ images, comicInfoEntry });
    });
    zipFile.once('error', reject);
    zipFile.readEntry();
  });
}

async function parseComicArchive(filePath: string, originalName?: string): Promise<ParsedComicArchive> {
  const ext = extname(filePath).toLowerCase();
  const format = ext === '.cbz' ? 'cbz' : 'zip';
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error('漫画压缩包不存在或不可读');
  if (fileStat.size > MAX_ARCHIVE_SIZE_BYTES) throw new Error(`漫画压缩包过大：当前限制 ${formatImportByteLimit(MAX_ARCHIVE_SIZE_BYTES)}，可通过 COMIC_MAX_ARCHIVE_SIZE_BYTES 调整`);
  const { images, comicInfoEntry } = await listArchiveEntries(filePath);
  if (images.length === 0) throw new Error('漫画压缩包内没有可导入的图片');
  if (images.length > MAX_IMAGE_COUNT) throw new Error(`漫画图片数量超过限制（${MAX_IMAGE_COUNT}）`);
  images.sort((left, right) => collator.compare(left.name, right.name));
  let comicInfo: ParsedComicInfo | null = null;
  if (comicInfoEntry) comicInfo = parseComicInfoXml((await readZipEntry(filePath, comicInfoEntry.name)).toString('utf8'));
  const pages = images.map((entry, index) => ({ index: index + 1, title: `第 ${index + 1} 页`, entryPath: entry.name, mediaType: entryMimeType(entry.name), size: entry.uncompressedSize }));
  const coverByInfo = comicInfo?.coverImageIndex !== undefined ? pages.find((page) => page.index - 1 === comicInfo?.coverImageIndex || page.index === comicInfo?.coverImageIndex) : undefined;
  const coverEntryPath = coverByInfo?.entryPath ?? pages.find((page) => /(cover|folder|front|封面)/i.test(basename(page.entryPath)))?.entryPath ?? pages[0].entryPath;
  const imageFormats = [...new Set(pages.map((page) => extname(page.entryPath).toLowerCase().replace(/^\./, '')))].sort();
  return {
    title: comicInfo?.title || titleFromFile(filePath, originalName),
    author: comicInfo?.writer || comicInfo?.penciller || '未知作者',
    description: comicInfo?.summary ?? null,
    format,
    pageCount: pages.length,
    coverEntryPath,
    pages,
    comicInfo,
    rawMetadata: comicInfo ? { hasComicInfo: true, comicInfo: comicInfo.raw, pageCount: pages.length, imageFormats, coverEntryPath } : { hasComicInfo: false, pageCount: pages.length, imageFormats, coverEntryPath }
  };
}

async function logImport(importTaskId: string | null | undefined, level: string, message: string) {
  if (!importTaskId) return;
  await prisma.importLog.create({ data: { importTaskId, level, message } });
}

async function managedPathFor(importTaskId: string, ext: string) {
  const directory = join(LIBRARY_STORAGE_ROOT, importTaskId.slice(0, 2));
  await mkdir(directory, { recursive: true });
  return join(directory, `${importTaskId}-${randomUUID()}${ext}`);
}

function fileHashForPath(path: string) {
  return createHash('sha256').update(path).digest('hex');
}

function comicMimeType(format: 'cbz' | 'zip') {
  return format === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/zip';
}

function sourceParentPath(options: ImportManagedBookOptions) {
  if (options.origin !== 'WATCH') return null;
  return dirname(resolve(options.sourceFilePath));
}

async function ensureImportTask(options: ImportManagedBookOptions) {
  if (options.importTaskId) return options.importTaskId;
  const task = await prisma.importTask.create({
    data: {
      origin: options.origin,
      monitorFolderId: options.monitorFolderId ?? null,
      sourcePath: options.sourceFilePath,
      originalName: options.originalName ?? basename(options.sourceFilePath),
      status: 'PENDING',
      message: '等待导入'
    }
  });
  return task.id;
}

function normalizeLibraryKey(value: string | null | undefined) {
  return (value ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\s_\-.[\]()（）【】《》:：,，!！?？]+/g, '')
    .trim();
}

function sourceGroupKey(options: ImportManagedBookOptions, fallbackTitle: string) {
  const parent = sourceParentPath(options);
  if (parent) return `watch:${normalizeLibraryKey(parent)}`;
  return `manual:${normalizeLibraryKey(fallbackTitle)}`;
}

function comicVolumeFromParsed(parsed: Pick<ParsedComicArchive, 'comicInfo'>, filePath: string, originalName?: string) {
  if (parsed.comicInfo?.series && Number.isFinite(parsed.comicInfo.volume)) {
    return {
      seriesName: parsed.comicInfo.series,
      seriesIndex: parsed.comicInfo.volume as number,
      title: `${parsed.comicInfo.series} (${parsed.comicInfo.volume})`
    };
  }
  return parseComicVolumeFromName(filePath, originalName);
}

function comicWorkTitle(parsed: Pick<ParsedComicArchive, 'title' | 'comicInfo'>, volume: ParsedComicVolume, options: ImportManagedBookOptions) {
  if (volume?.seriesName) return volume.seriesName;
  if (parsed.comicInfo?.series) return parsed.comicInfo.series;
  const parent = sourceParentPath(options);
  if (parent && options.origin === 'WATCH') return cleanComicTitlePart(basename(parent));
  return parsed.title;
}

async function workHasExternalMetadata(workId: string) {
  const count = await prisma.metadataSuggestion.count({
    where: {
      source: 'external',
      job: { workId }
    }
  });
  return count > 0;
}

function workMergeKey(format: 'epub' | 'cbz' | 'zip', title: string, author?: string | null, identifier?: string | null, isbn?: string | null) {
  if (isbn) return `isbn:${normalizeLibraryKey(isbn)}`;
  if (identifier) return `id:${normalizeLibraryKey(identifier)}`;
  return `${format === 'epub' ? 'epub' : 'comic'}:${normalizeLibraryKey(title)}:${normalizeLibraryKey(author)}`;
}

async function nextEditionName(workId: string, base: string) {
  const count = await prisma.libraryEdition.count({ where: { workId } });
  return count === 0 ? base : `${base} ${count + 1}`;
}

async function ensureWork(data: {
  title: string;
  author: string;
  description?: string | null;
  workType: 'EPUB' | 'COMIC';
  tags: string[];
  mergeKey: string;
  origin: BookOrigin;
  monitorFolderId?: string | null;
}) {
  const createData = {
    monitorFolderId: data.monitorFolderId ?? null,
    origin: data.origin,
    title: data.title,
    normalizedTitle: normalizeLibraryKey(data.title),
    author: data.author,
    normalizedAuthor: normalizeLibraryKey(data.author),
    description: data.description ?? null,
    workType: data.workType,
    tags: JSON.stringify(data.tags),
    mergeKey: data.mergeKey
  };

  try {
    const work = await prisma.libraryWork.upsert({
      where: { mergeKey: data.mergeKey },
      create: createData,
      update: { hidden: false }
    });
    return { work, created: work.createdAt.getTime() === work.updatedAt.getTime() };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.libraryWork.findUnique({ where: { mergeKey: data.mergeKey } });
      if (existing) return { work: existing, created: false };
    }
    throw error;
  }
}

async function finalizeWorkPrimary(workId: string, editionId: string, coverPath?: string | null) {
  const work = await prisma.libraryWork.findUnique({ where: { id: workId } });
  if (!work) return;
  await prisma.libraryWork.update({
    where: { id: workId },
    data: {
      primaryEditionId: work.primaryEditionId ?? editionId,
      coverPath: work.coverPath ?? coverPath ?? null,
      coverStatus: work.coverPath || coverPath ? 'READY' : work.coverStatus
    }
  });
}

async function importReadableEpub(options: ImportManagedBookOptions & { importTaskId: string; fileSize: number; ext: string }): Promise<ImportManagedBookResult> {
  const metadata = await parseEpubMetadata(options.sourceFilePath);
  const mergeKey = workMergeKey('epub', metadata.title, metadata.author, metadata.identifier, metadata.isbn);
  const { work, created } = await ensureWork({
    title: metadata.title,
    author: metadata.author,
    description: metadata.description,
    workType: 'EPUB',
    tags: metadata.subjects?.length ? metadata.subjects : ['epub'],
    mergeKey,
    origin: options.origin,
    monitorFolderId: options.monitorFolderId
  });
  const existingEdition = !created
    ? await prisma.libraryEdition.findFirst({
        where: { workId: work.id, format: 'EPUB', hidden: false },
        include: { volumes: { orderBy: { sortOrder: 'asc' } }, files: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { createdAt: 'asc' }
      })
    : null;
  if (existingEdition) {
    return {
      bookId: work.id,
      workId: work.id,
      editionId: existingEdition.id,
      volumeId: existingEdition.volumes[0]?.id ?? null,
      title: work.title,
      type: 'ebook',
      format: 'epub',
      totalUnits: existingEdition.chapterCount ?? metadata.chapterCount,
      coverUrl: work.coverPath ? storageUrl(work.coverPath) : null,
      importStatus: 'completed',
      duplicate: true,
      merged: true,
      mergeReason: 'duplicate-epub-metadata'
    };
  }
  const managedFilePath = await managedPathFor(options.importTaskId, options.ext);
  await copyFile(options.sourceFilePath, managedFilePath);
  await prisma.importTask.update({ where: { id: options.importTaskId }, data: { managedFilePath, message: '正在建立 EPUB 记录' } });
  const versionName = await nextEditionName(work.id, 'EPUB');
  const edition = await prisma.libraryEdition.create({
    data: {
      workId: work.id,
      monitorFolderId: options.monitorFolderId ?? null,
      origin: options.origin,
      format: 'EPUB',
      versionName,
      versionKey: 'epub:primary',
      description: metadata.description,
      language: metadata.language,
      publisher: metadata.publisher,
      publishedAt: metadata.publishedAt,
      identifier: metadata.identifier,
      isbn: metadata.isbn,
      sizeBytes: BigInt(options.fileSize),
      chapterCount: metadata.chapterCount,
      importStatus: 'PARSING',
      primary: !work.primaryEditionId
    }
  });
  let coverPath: string | null = null;
  try {
    if (metadata.coverPath) {
      const rel = normalize(join(dirname(metadata.opfPath), metadata.coverPath)).replace(/^\/+/, '');
      const coverExt = extname(metadata.coverPath) || '.jpg';
      coverPath = resolve(BOOK_ASSET_ROOT, work.id, edition.id, `cover${coverExt}`);
      await mkdir(dirname(coverPath), { recursive: true });
      await writeFile(coverPath, await readZipEntry(managedFilePath, rel));
    }
    const volume = await prisma.libraryVolume.create({
      data: {
        editionId: edition.id,
        title: '正文',
        sortOrder: 0,
        chapterCount: metadata.chapterCount,
        coverPath
      }
    });
    const managedMtimeMs = BigInt(Math.trunc((await stat(managedFilePath)).mtimeMs));
    const file = await prisma.libraryFile.create({
      data: {
        editionId: edition.id,
        volumeId: volume.id,
        path: managedFilePath,
        filePathHash: fileHashForPath(managedFilePath),
        fingerprint: null,
        fullHash: null,
        hashStatus: 'PARTIAL_PENDING',
        kind: 'EPUB',
        mimeType: 'application/epub+zip',
        sortOrder: 0,
        sizeBytes: BigInt(options.fileSize),
        mtimeMs: managedMtimeMs
      }
    });
    await prisma.$transaction([
      prisma.libraryReadingUnit.createMany({
        data: metadata.chapters.map((chapter) => ({
          editionId: edition.id,
          volumeId: volume.id,
          fileId: file.id,
          unitType: 'chapter',
          title: chapter.title,
          href: chapter.href,
          mediaType: chapter.mediaType ?? null,
          sortOrder: chapter.sortOrder,
          metadataJson: JSON.stringify({ idref: chapter.idref })
        }))
      }),
      prisma.libraryMetadata.create({ data: { editionId: edition.id, source: 'epub_opf', rawJson: JSON.stringify(metadata.rawMetadata) } }),
      prisma.libraryEdition.update({ where: { id: edition.id }, data: { coverPath, coverStatus: coverPath ? 'READY' : 'PENDING', importStatus: 'COMPLETED' } })
    ]);
    await finalizeWorkPrimary(work.id, edition.id, coverPath);
    return {
      bookId: work.id,
      workId: work.id,
      editionId: edition.id,
      volumeId: volume.id,
      title: work.title,
      type: 'ebook',
      format: 'epub',
      totalUnits: metadata.chapterCount,
      coverUrl: coverPath ? storageUrl(coverPath) : null,
      importStatus: 'completed',
      duplicate: false,
      merged: !created,
      mergeReason: created ? 'new-work' : 'same-epub-work'
    };
  } catch (error) {
    if (coverPath) await unlink(coverPath).catch(() => undefined);
    await prisma.libraryEdition.update({ where: { id: edition.id }, data: { importStatus: 'FAILED', importError: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    throw error;
  }
}

async function selectComicEdition(workId: string, volumeIndex: number | null, sourceKey: string, volumeTitle: string) {
  const editions = await prisma.libraryEdition.findMany({
    where: { workId, format: 'COMIC', hidden: false },
    include: { volumes: true },
    orderBy: { createdAt: 'asc' }
  });
  const hasConflict = (edition: (typeof editions)[number]) =>
    volumeIndex === null
      ? edition.volumes.some((volume) => normalizeLibraryKey(volume.title) === normalizeLibraryKey(volumeTitle))
      : edition.volumes.some((volume) => volume.volumeIndex === volumeIndex);
  return editions.find((edition) => edition.sourceGroupKey === sourceKey && !hasConflict(edition))
    ?? editions.find((edition) => !hasConflict(edition))
    ?? null;
}

async function findComicDuplicateVolume(workId: string, volumeIndex: number | null, volumeTitle: string) {
  const editions = await prisma.libraryEdition.findMany({
    where: { workId, format: 'COMIC', hidden: false },
    include: { volumes: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { createdAt: 'asc' }
  });
  for (const edition of editions) {
    const volume = volumeIndex === null
      ? edition.volumes.find((item) => normalizeLibraryKey(item.title) === normalizeLibraryKey(volumeTitle)) ?? null
      : edition.volumes.find((item) => item.volumeIndex === volumeIndex) ?? null;
    if (volume) return { edition, volume };
  }
  return null;
}

async function importReadableComic(options: ImportManagedBookOptions & { importTaskId: string; fileSize: number; ext: string }): Promise<ImportManagedBookResult> {
  const parsed = await parseComicArchive(options.sourceFilePath, options.originalName);
  const volumeInfo = comicVolumeFromParsed(parsed, options.sourceFilePath, options.originalName);
  const title = comicWorkTitle(parsed, volumeInfo, options);
  const author = volumeInfo?.author || parsed.author;
  const mergeKey = workMergeKey('cbz', title, author);
  const sourceKey = sourceGroupKey(options, title);
  const volumeIndex = Number.isFinite(volumeInfo?.seriesIndex) ? Number(volumeInfo?.seriesIndex) : null;
  const volumeTitle = volumeIndex !== null ? `第 ${volumeIndex} 卷` : (parsed.comicInfo?.title ?? parsed.title);
  const { work, created } = await ensureWork({
    title,
    author,
    description: parsed.description,
    workType: 'COMIC',
    tags: parsed.comicInfo?.tags ?? ['comic', parsed.format],
    mergeKey,
    origin: options.origin,
    monitorFolderId: options.monitorFolderId
  });
  const refreshExternalMetadata = created || !(await workHasExternalMetadata(work.id));
  const duplicate = await findComicDuplicateVolume(work.id, volumeIndex, volumeTitle);
  if (duplicate) {
    return {
      bookId: work.id,
      workId: work.id,
      editionId: duplicate.edition.id,
      volumeId: duplicate.volume.id,
      title: work.title,
      type: 'comic',
      format: parsed.format,
      totalUnits: duplicate.volume.pageCount ?? duplicate.edition.pageCount ?? 0,
      coverUrl: work.coverPath ? storageUrl(work.coverPath) : null,
      importStatus: 'completed',
      duplicate: true,
      merged: true,
      mergeReason: 'duplicate-comic-metadata',
      refreshExternalMetadata: false
    };
  }

  let edition = await selectComicEdition(work.id, volumeIndex, sourceKey, volumeTitle);
  let createdEdition = false;
  if (!edition) {
    createdEdition = true;
    edition = await prisma.libraryEdition.create({
      data: {
        workId: work.id,
        monitorFolderId: options.monitorFolderId ?? null,
        origin: options.origin,
        format: 'COMIC',
        versionName: await nextEditionName(work.id, '漫画版本'),
        versionKey: `comic:${sourceKey}`,
        sourceGroupKey: sourceKey,
        description: parsed.description,
        importStatus: 'PARSING',
        primary: !work.primaryEditionId
      },
      include: { volumes: true }
    });
  }

  let coverPath: string | null = null;
  try {
    const sortOrder = volumeIndex !== null ? Math.trunc(volumeIndex * 1000) : edition.volumes.length;
    const volume = await prisma.libraryVolume.create({
      data: {
        editionId: edition.id,
        title: volumeTitle,
        volumeIndex,
        sortOrder,
        pageCount: parsed.pageCount,
        coverPath: null
      }
    });
    const managedFilePath = await managedPathFor(options.importTaskId, options.ext);
    await copyFile(options.sourceFilePath, managedFilePath);
    await prisma.importTask.update({ where: { id: options.importTaskId }, data: { managedFilePath, message: '正在建立漫画记录' } });
    const mtimeMs = BigInt(Math.trunc((await stat(managedFilePath)).mtimeMs));
    const file = await prisma.libraryFile.create({
      data: {
        editionId: edition.id,
        volumeId: volume.id,
        path: managedFilePath,
        filePathHash: fileHashForPath(managedFilePath),
        fingerprint: null,
        fullHash: null,
        hashStatus: 'PARTIAL_PENDING',
        kind: 'COMIC',
        mimeType: comicMimeType(parsed.format),
        sortOrder,
        sizeBytes: BigInt(options.fileSize),
        mtimeMs
      }
    });
    const coverExt = extname(parsed.coverEntryPath).toLowerCase() || '.jpg';
    coverPath = resolve(BOOK_ASSET_ROOT, work.id, edition.id, volume.id, `cover${coverExt}`);
    await mkdir(dirname(coverPath), { recursive: true });
    await writeFile(coverPath, await readZipEntry(managedFilePath, parsed.coverEntryPath));
    const editionPageCount = edition.volumes.reduce((total, item) => total + (item.pageCount ?? 0), 0) + parsed.pageCount;
    await prisma.$transaction([
      prisma.libraryReadingUnit.createMany({
        data: parsed.pages.map((page) => ({
          editionId: edition.id,
          volumeId: volume.id,
          fileId: file.id,
          unitType: 'page',
          title: page.title,
          href: page.entryPath,
          mediaType: page.mediaType,
          sortOrder: page.index,
          size: page.size ? BigInt(page.size) : null,
          metadataJson: JSON.stringify({
            zipEntryName: page.entryPath,
            originalName: basename(page.entryPath),
            pageInVolume: page.index,
            pageInSection: page.index,
            volumeIndex,
            sourceFileName: options.originalName ?? basename(options.sourceFilePath)
          })
        })),
        skipDuplicates: true
      }),
      prisma.libraryMetadata.create({
        data: {
          editionId: edition.id,
          source: parsed.comicInfo ? 'comic_info' : 'system',
          rawJson: JSON.stringify({ ...parsed.rawMetadata, volumeIndex, sourceFileName: options.originalName ?? basename(options.sourceFilePath) })
        }
      }),
      prisma.libraryVolume.update({ where: { id: volume.id }, data: { coverPath, pageCount: parsed.pageCount } })
    ]);
    const sizeTotals = await prisma.libraryFile.aggregate({ where: { editionId: edition.id }, _sum: { sizeBytes: true } });
    await prisma.libraryEdition.update({
      where: { id: edition.id },
      data: {
        sizeBytes: sizeTotals._sum.sizeBytes ?? BigInt(options.fileSize),
        pageCount: editionPageCount,
        coverPath: edition.coverPath ?? coverPath,
        coverStatus: 'READY',
        importStatus: 'COMPLETED'
      }
    });
    await finalizeWorkPrimary(work.id, edition.id, coverPath);
    return {
      bookId: work.id,
      workId: work.id,
      editionId: edition.id,
      volumeId: volume.id,
      title: work.title,
      type: 'comic',
      format: parsed.format,
      totalUnits: parsed.pageCount,
      coverUrl: coverPath ? storageUrl(coverPath) : null,
      importStatus: 'completed',
      duplicate: false,
      merged: !created || !createdEdition,
      mergeReason: created ? 'new-comic-work' : createdEdition ? 'new-comic-version' : 'same-comic-series',
      refreshExternalMetadata
    };
  } catch (error) {
    if (coverPath) await unlink(coverPath).catch(() => undefined);
    await prisma.libraryEdition.update({ where: { id: edition.id }, data: { importStatus: 'FAILED', importError: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    throw error;
  }
}

export async function importManagedBook(options: ImportManagedBookOptions): Promise<ImportManagedBookResult> {
  const importTaskId = await ensureImportTask(options);
  const ext = extname(options.originalName || options.sourceFilePath).toLowerCase();
  if (!supportedExts.has(ext)) throw new Error('当前版本仅支持 EPUB、CBZ、ZIP 格式。');
  const startedAt = Date.now();
  await prisma.importTask.update({ where: { id: importTaskId }, data: { status: 'PARSING', progress: 5, startedAt: new Date(startedAt), message: '正在校验文件' } });
  await logImport(importTaskId, 'info', `import started: ${options.sourceFilePath}`);

  try {
    const fileStat = await stat(options.sourceFilePath);
    if (!fileStat.isFile()) throw new Error('导入源不是文件');
    await prisma.importTask.update({ where: { id: importTaskId }, data: { progress: 30, message: '正在读取元数据' } });

    const result = ext === '.epub'
      ? await importReadableEpub({ ...options, importTaskId, fileSize: fileStat.size, ext })
      : await importReadableComic({ ...options, importTaskId, fileSize: fileStat.size, ext });

    await prisma.importTask.update({
      where: { id: importTaskId },
      data: {
        workId: result.workId,
        editionId: result.editionId,
        volumeId: result.volumeId,
        status: 'COMPLETED',
        progress: 100,
        duplicate: result.duplicate,
        message: result.duplicate ? '读物已存在，跳过重复导入' : result.merged ? `导入完成：${result.mergeReason ?? '已合并'}` : '导入完成',
        duration: Date.now() - startedAt,
        finishedAt: new Date()
      }
    });
    if (result.workId && !result.duplicate) {
      const job = await createOrRefreshOrganizeJob({ workId: result.workId, editionId: result.editionId, importTaskId }).catch(async (error) => {
        await logImport(importTaskId, 'warn', `organize job skipped: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (job) {
        await refreshAndApplyImportMetadata(job.id, { includeExternal: result.refreshExternalMetadata !== false })
          .then((metadataResult) => {
            if (!metadataResult.enabled) {
              return logImport(importTaskId, 'info', 'metadata auto refresh skipped: no enabled providers');
            }
            const providerLabels = metadataResult.providers.join(',');
            const added = metadataResult.refresh?.added ?? 0;
            const disabled = metadataResult.refresh?.results.filter((item) => !item.enabled).map((item) => `${item.provider}:${item.message ?? 'disabled'}`) ?? [];
            const errors = metadataResult.refresh?.results.filter((item) => item.error).map((item) => `${item.provider}:${item.error}`) ?? [];
            return logImport(
              importTaskId,
              errors.length ? 'warn' : 'info',
              `metadata auto refresh providers=${providerLabels} added=${added} applied=${metadataResult.applied}${disabled.length ? ` disabled=${disabled.join('|')}` : ''}${errors.length ? ` errors=${errors.join('|')}` : ''}`
            );
          })
          .catch((error) => logImport(importTaskId, 'warn', `metadata auto refresh skipped: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    await logImport(importTaskId, 'info', `import completed: ${result.bookId}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.importTask.update({
      where: { id: importTaskId },
      data: { status: 'FAILED', progress: 100, errorSummary: message, message: `导入失败：${message}`, duration: Date.now() - startedAt, finishedAt: new Date() }
    }).catch(() => undefined);
    await logImport(importTaskId, 'error', message).catch(() => undefined);
    throw error;
  }
}

export const importReadableItem = importManagedBook;

export async function ensureComicVolumePageIndex(volumeId: string) {
  const existingCount = await prisma.libraryReadingUnit.count({ where: { volumeId, unitType: 'page' } });
  if (existingCount > 0) return existingCount;

  const volume = await prisma.libraryVolume.findUnique({
    where: { id: volumeId },
    include: {
      edition: { include: { work: true } },
      files: { orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!volume) throw new Error('漫画卷不存在');
  const file = volume.files[0];
  if (!file) throw new Error('漫画文件不存在');

  const { images, comicInfoEntry } = await listArchiveEntries(file.path);
  if (images.length === 0) throw new Error('漫画压缩包内没有可读取的图片');
  if (images.length > MAX_IMAGE_COUNT) throw new Error(`漫画图片数量超过限制（${MAX_IMAGE_COUNT}）`);
  images.sort((left, right) => collator.compare(left.name, right.name));

  let comicInfo: ParsedComicInfo | null = null;
  if (comicInfoEntry) comicInfo = parseComicInfoXml((await readZipEntry(file.path, comicInfoEntry.name)).toString('utf8'));
  const pages = images.map((entry, index) => ({ index: index + 1, title: `第 ${index + 1} 页`, entryPath: entry.name, mediaType: entryMimeType(entry.name), size: entry.uncompressedSize }));
  const coverByInfo = comicInfo?.coverImageIndex !== undefined ? pages.find((page) => page.index - 1 === comicInfo?.coverImageIndex || page.index === comicInfo?.coverImageIndex) : undefined;
  const coverEntryPath = coverByInfo?.entryPath ?? pages.find((page) => /(cover|folder|front|封面)/i.test(basename(page.entryPath)))?.entryPath ?? pages[0].entryPath;
  const coverExt = extname(coverEntryPath).toLowerCase() || '.jpg';
  const coverPath = resolve(BOOK_ASSET_ROOT, volume.edition.workId, volume.editionId, volume.id, `cover${coverExt}`);
  await mkdir(dirname(coverPath), { recursive: true });
  await writeFile(coverPath, await readZipEntry(file.path, coverEntryPath));

  await prisma.libraryReadingUnit.createMany({
    data: pages.map((page) => ({
      editionId: volume.editionId,
      volumeId: volume.id,
      fileId: file.id,
      unitType: 'page',
      title: page.title,
      href: page.entryPath,
      mediaType: page.mediaType,
      sortOrder: page.index,
      size: page.size ? BigInt(page.size) : null,
      metadataJson: JSON.stringify({
        zipEntryName: page.entryPath,
        originalName: basename(page.entryPath),
        pageInVolume: page.index,
        pageInSection: page.index,
        volumeIndex: volume.volumeIndex,
        sourceFileName: basename(file.path)
      })
    })),
    skipDuplicates: true
  });

  const indexedCount = await prisma.libraryReadingUnit.count({ where: { volumeId, unitType: 'page' } });
  const totals = await prisma.libraryVolume.aggregate({ where: { editionId: volume.editionId }, _sum: { pageCount: true } });
  await prisma.$transaction([
    prisma.libraryVolume.update({ where: { id: volume.id }, data: { pageCount: indexedCount, coverPath } }),
    prisma.libraryEdition.update({
      where: { id: volume.editionId },
      data: {
        pageCount: totals._sum.pageCount ? Number(totals._sum.pageCount) - (volume.pageCount ?? 0) + indexedCount : indexedCount,
        coverPath: volume.edition.coverPath ?? coverPath,
        coverStatus: 'READY'
      }
    }),
    prisma.libraryWork.update({
      where: { id: volume.edition.workId },
      data: {
        coverPath: volume.edition.work.coverPath ?? coverPath,
        coverStatus: 'READY'
      }
    })
  ]);
  return indexedCount;
}

export function isSupportedImportFile(filePath: string) {
  return supportedExts.has(extname(filePath).toLowerCase());
}

export function managedLibraryRoot() {
  return LIBRARY_STORAGE_ROOT;
}

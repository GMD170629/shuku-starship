import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, posix, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { prisma } from '@shuku/database';
import { Prisma } from '@prisma/client';
import type { BookOrigin } from '@prisma/client';

const DEFAULT_COVER = '/covers/default.svg';
const STORAGE_ROOT = resolve(process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage'));
const LIBRARY_STORAGE_ROOT = process.env.LIBRARY_STORAGE_ROOT ?? join(STORAGE_ROOT, 'library');
const BOOK_ASSET_ROOT = join(STORAGE_ROOT, 'books');

const MAX_EPUB_SIZE_BYTES = Number(process.env.EPUB_MAX_SIZE_BYTES ?? 200 * 1024 * 1024);
const MAX_ARCHIVE_SIZE_BYTES = Number(process.env.COMIC_MAX_ARCHIVE_SIZE_BYTES ?? 2 * 1024 * 1024 * 1024);
const MAX_ENTRIES = Number(process.env.IMPORT_MAX_ENTRIES ?? 10000);
const MAX_IMAGE_COUNT = Number(process.env.COMIC_MAX_IMAGE_COUNT ?? 5000);
const MAX_SINGLE_IMAGE_BYTES = Number(process.env.COMIC_MAX_SINGLE_IMAGE_BYTES ?? 80 * 1024 * 1024);
const XML_MAX_BYTES = Number(process.env.COMIC_INFO_MAX_BYTES ?? 2 * 1024 * 1024);

const supportedExts = new Set(['.epub', '.cbz', '.zip']);
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

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

export function parseComicVolumeFromName(filePath: string, originalName?: string): ParsedComicVolume {
  const source = originalName || basename(filePath);
  const baseTitle = basename(source, extname(source));
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

async function sha256File(path: string) {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolveHash());
    stream.once('error', reject);
  });
  return hash.digest('hex');
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
  if (fileStat.size > MAX_EPUB_SIZE_BYTES) throw new Error('EPUB 文件过大');
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
  if (fileStat.size > MAX_ARCHIVE_SIZE_BYTES) throw new Error(`漫画压缩包超过限制（${MAX_ARCHIVE_SIZE_BYTES} bytes）`);
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

async function managedPathFor(contentHash: string, ext: string) {
  const directory = join(LIBRARY_STORAGE_ROOT, contentHash.slice(0, 2));
  await mkdir(directory, { recursive: true });
  return join(directory, `${contentHash}${ext}`);
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

function parentPrefix(path: string) {
  return path.endsWith('/') ? path : `${path}/`;
}

function comicSectionTitle(volume: ParsedComicVolume) {
  return volume ? `第 ${volume.seriesIndex} 卷` : '正文';
}

function comicSectionId(bookFileId: string) {
  return `file:${bookFileId}`;
}

async function findComicSeriesTarget(options: ImportManagedBookOptions, volume: NonNullable<ParsedComicVolume>) {
  const parent = sourceParentPath(options);
  if (!parent) return null;
  const tasks = await prisma.importTask.findMany({
    where: {
      monitorFolderId: options.monitorFolderId ?? null,
      sourcePath: { startsWith: parentPrefix(parent) },
      book: {
        hidden: false,
        format: 'COMIC',
        seriesName: volume.seriesName
      }
    },
    include: {
      book: {
        include: {
          files: { orderBy: { sortOrder: 'asc' } }
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });
  return tasks.find((task) => task.book && dirname(resolve(task.sourcePath)) === parent)?.book ?? null;
}

function comicFileSortKey(file: { path: string; sortOrder: number }, volumeByPath: Map<string, number>) {
  return volumeByPath.get(file.path) ?? parseComicVolumeFromName(file.path)?.seriesIndex ?? file.sortOrder;
}

async function reorderComicBookFilesAndPages(bookId: string) {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!book) return;

  const volumeByPath = new Map<string, number>();
  for (const unit of book.readingUnits) {
    if (!unit.filePath) continue;
    try {
      const metadata = JSON.parse(unit.metadataJson) as { volumeIndex?: unknown };
      const volumeIndex = Number(metadata.volumeIndex);
      if (Number.isFinite(volumeIndex)) volumeByPath.set(unit.filePath, volumeIndex);
    } catch {
      // Ignore old metadata that cannot be parsed.
    }
  }

  const files = [...book.files].sort((left, right) => {
    const volumeCompare = comicFileSortKey(left, volumeByPath) - comicFileSortKey(right, volumeByPath);
    return volumeCompare || collator.compare(basename(left.path), basename(right.path));
  });

  const unitsByPath = new Map<string, typeof book.readingUnits>();
  for (const unit of book.readingUnits) {
    const key = unit.filePath ?? '';
    unitsByPath.set(key, [...(unitsByPath.get(key) ?? []), unit]);
  }

  const updates: Prisma.PrismaPromise<unknown>[] = [];
  files.forEach((file, index) => {
    if (file.sortOrder !== index) updates.push(prisma.bookFile.update({ where: { id: file.id }, data: { sortOrder: index } }));
  });

  let nextPage = 1;
  for (const file of files) {
    const units = [...(unitsByPath.get(file.path) ?? [])].sort((left, right) => {
      const leftEntry = safeJsonObject(left.metadataJson).pageInVolume ?? left.sortOrder;
      const rightEntry = safeJsonObject(right.metadataJson).pageInVolume ?? right.sortOrder;
      return Number(leftEntry) - Number(rightEntry);
    });
    for (const [index, unit] of units.entries()) {
      const pageInSection = index + 1;
      const nextTitle = `第 ${pageInSection} 页`;
      const metadata = safeJsonObject(unit.metadataJson);
      const nextMetadata = JSON.stringify({ ...metadata, pageInSection });
      if (unit.sortOrder !== pageInSection || unit.title !== nextTitle || unit.metadataJson !== nextMetadata) {
        updates.push(prisma.readingUnit.update({ where: { id: unit.id }, data: { sortOrder: pageInSection, title: nextTitle, metadataJson: nextMetadata } }));
      }
    }
    nextPage += units.length;
  }

  updates.push(prisma.book.update({ where: { id: bookId }, data: { pageCount: nextPage - 1 } }));
  if (updates.length > 0) await prisma.$transaction(updates);
}

function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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

function comicVolumeFromParsed(parsed: ParsedComicArchive, filePath: string, originalName?: string) {
  if (parsed.comicInfo?.series && Number.isFinite(parsed.comicInfo.volume)) {
    return {
      seriesName: parsed.comicInfo.series,
      seriesIndex: parsed.comicInfo.volume as number,
      title: `${parsed.comicInfo.series} (${parsed.comicInfo.volume})`
    };
  }
  return parseComicVolumeFromName(filePath, originalName);
}

function comicWorkTitle(parsed: ParsedComicArchive, volume: ParsedComicVolume, options: ImportManagedBookOptions) {
  if (volume?.seriesName) return volume.seriesName;
  if (parsed.comicInfo?.series) return parsed.comicInfo.series;
  const parent = sourceParentPath(options);
  if (parent && options.origin === 'WATCH') return cleanComicTitlePart(basename(parent));
  return parsed.title;
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

async function importReadableEpub(options: ImportManagedBookOptions & { importTaskId: string; managedFilePath: string; contentHash: string; fileSize: number }): Promise<ImportManagedBookResult> {
  const metadata = await parseEpubMetadata(options.managedFilePath);
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
  const versionName = await nextEditionName(work.id, 'EPUB');
  const edition = await prisma.libraryEdition.create({
    data: {
      workId: work.id,
      monitorFolderId: options.monitorFolderId ?? null,
      origin: options.origin,
      format: 'EPUB',
      versionName,
      versionKey: `epub:${options.contentHash.slice(0, 32)}`,
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
      await writeFile(coverPath, await readZipEntry(options.managedFilePath, rel));
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
    const managedMtimeMs = BigInt(Math.trunc((await stat(options.managedFilePath)).mtimeMs));
    const file = await prisma.libraryFile.create({
      data: {
        editionId: edition.id,
        volumeId: volume.id,
        path: options.managedFilePath,
        filePathHash: fileHashForPath(options.managedFilePath),
        fingerprint: `full:${options.contentHash}`,
        fullHash: options.contentHash,
        hashStatus: 'FULL',
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

async function selectComicEdition(workId: string, volumeIndex: number | null, sourceKey: string) {
  const editions = await prisma.libraryEdition.findMany({
    where: { workId, format: 'COMIC', hidden: false },
    include: { volumes: true },
    orderBy: { createdAt: 'asc' }
  });
  const noConflict = editions.find((edition) => {
    if (edition.sourceGroupKey && edition.sourceGroupKey !== sourceKey) return false;
    if (volumeIndex === null) return edition.volumes.length === 0;
    return !edition.volumes.some((volume) => volume.volumeIndex === volumeIndex);
  });
  if (noConflict) return noConflict;
  return null;
}

async function importReadableComic(options: ImportManagedBookOptions & { importTaskId: string; managedFilePath: string; contentHash: string; fileSize: number; ext: string }): Promise<ImportManagedBookResult> {
  const parsed = await parseComicArchive(options.managedFilePath, options.originalName);
  const volumeInfo = comicVolumeFromParsed(parsed, options.sourceFilePath, options.originalName);
  const title = comicWorkTitle(parsed, volumeInfo, options);
  const author = parsed.author;
  const mergeKey = workMergeKey('cbz', title, author);
  const sourceKey = sourceGroupKey(options, title);
  const volumeIndex = Number.isFinite(volumeInfo?.seriesIndex) ? Number(volumeInfo?.seriesIndex) : null;
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

  let edition = await selectComicEdition(work.id, volumeIndex, sourceKey);
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
        versionKey: `comic:${sourceKey}:${Date.now()}:${options.contentHash.slice(0, 8)}`,
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
        title: volumeIndex !== null ? `第 ${volumeIndex} 卷` : (parsed.comicInfo?.title ?? parsed.title),
        volumeIndex,
        sortOrder,
        pageCount: parsed.pageCount
      }
    });
    const coverExt = extname(parsed.coverEntryPath).toLowerCase() || '.jpg';
    coverPath = resolve(BOOK_ASSET_ROOT, work.id, edition.id, volume.id, `cover${coverExt}`);
    await mkdir(dirname(coverPath), { recursive: true });
    await writeFile(coverPath, await readZipEntry(options.managedFilePath, parsed.coverEntryPath));
    const mtimeMs = BigInt(Math.trunc((await stat(options.managedFilePath)).mtimeMs));
    const file = await prisma.libraryFile.create({
      data: {
        editionId: edition.id,
        volumeId: volume.id,
        path: options.managedFilePath,
        filePathHash: fileHashForPath(options.managedFilePath),
        fingerprint: `full:${options.contentHash}`,
        fullHash: options.contentHash,
        hashStatus: 'FULL',
        kind: 'COMIC',
        mimeType: comicMimeType(parsed.format),
        sortOrder,
        sizeBytes: BigInt(options.fileSize),
        mtimeMs
      }
    });
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
        }))
      }),
      prisma.libraryMetadata.create({
        data: {
          editionId: edition.id,
          source: parsed.comicInfo ? 'comic_info' : 'system',
          rawJson: JSON.stringify({ ...parsed.rawMetadata, volumeIndex, sourceFileName: options.originalName ?? basename(options.sourceFilePath) })
        }
      }),
      prisma.libraryVolume.update({ where: { id: volume.id }, data: { coverPath } })
    ]);
    const totals = await prisma.libraryVolume.aggregate({ where: { editionId: edition.id }, _sum: { pageCount: true } });
    const sizeTotals = await prisma.libraryFile.aggregate({ where: { editionId: edition.id }, _sum: { sizeBytes: true } });
    await prisma.libraryEdition.update({
      where: { id: edition.id },
      data: {
        sizeBytes: sizeTotals._sum.sizeBytes ?? BigInt(options.fileSize),
        pageCount: totals._sum.pageCount ?? parsed.pageCount,
        coverPath: edition.coverPath ?? coverPath,
        coverStatus: edition.coverPath || coverPath ? 'READY' : 'PENDING',
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
      totalUnits: totals._sum.pageCount ?? parsed.pageCount,
      coverUrl: coverPath ? storageUrl(coverPath) : null,
      importStatus: 'completed',
      duplicate: false,
      merged: !created || !createdEdition,
      mergeReason: created ? 'new-comic-work' : createdEdition ? 'new-comic-version' : 'same-comic-series'
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
    const contentHash = await sha256File(options.sourceFilePath);
    const managedFilePath = await managedPathFor(contentHash, ext);
    const duplicate = await prisma.libraryFile.findFirst({
      where: { fullHash: contentHash },
      include: { edition: { include: { work: true, volumes: { orderBy: { sortOrder: 'asc' } } } } }
    });
    if (duplicate) {
      await prisma.importTask.update({
        where: { id: importTaskId },
        data: {
          workId: duplicate.edition.workId,
          editionId: duplicate.editionId,
          volumeId: duplicate.volumeId,
          status: 'COMPLETED',
          progress: 100,
          duplicate: true,
          contentHash,
          managedFilePath: duplicate.path,
          message: '读物已存在，跳过重复导入',
          duration: Date.now() - startedAt,
          finishedAt: new Date()
        }
      });
      await logImport(importTaskId, 'info', `duplicate: ${duplicate.edition.workId}`);
      return {
        bookId: duplicate.edition.workId,
        workId: duplicate.edition.workId,
        editionId: duplicate.editionId,
        volumeId: duplicate.volumeId,
        title: duplicate.edition.work.title,
        type: duplicate.kind === 'COMIC' ? 'comic' : 'ebook',
        format: ext === '.epub' ? 'epub' : ext === '.cbz' ? 'cbz' : 'zip',
        totalUnits: duplicate.kind === 'COMIC' ? duplicate.edition.pageCount ?? 0 : duplicate.edition.chapterCount ?? 0,
        coverUrl: duplicate.edition.work.coverPath ? storageUrl(duplicate.edition.work.coverPath) : null,
        importStatus: 'completed',
        duplicate: true,
        merged: true,
        mergeReason: 'duplicate-full-hash'
      };
    }

    await copyFile(options.sourceFilePath, managedFilePath);
    await prisma.importTask.update({ where: { id: importTaskId }, data: { progress: 30, contentHash, managedFilePath, message: '正在读取元数据' } });

    const result = ext === '.epub'
      ? await importReadableEpub({ ...options, importTaskId, managedFilePath, contentHash, fileSize: fileStat.size })
      : await importReadableComic({ ...options, importTaskId, managedFilePath, contentHash, fileSize: fileStat.size, ext });

    await prisma.importTask.update({
      where: { id: importTaskId },
      data: {
        workId: result.workId,
        editionId: result.editionId,
        volumeId: result.volumeId,
        status: 'COMPLETED',
        progress: 100,
        duplicate: false,
        message: result.merged ? `导入完成：${result.mergeReason ?? '已合并'}` : '导入完成',
        duration: Date.now() - startedAt,
        finishedAt: new Date()
      }
    });
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

async function importManagedEpub(options: ImportManagedBookOptions & { importTaskId: string; managedFilePath: string; contentHash: string; fileSize: number }): Promise<ImportManagedBookResult> {
  const metadata = await parseEpubMetadata(options.managedFilePath);
  const book = await prisma.book.create({
    data: {
      monitorFolderId: options.monitorFolderId ?? null,
      origin: options.origin,
      title: metadata.title,
      author: metadata.author,
      description: metadata.description,
      format: 'EPUB',
      tags: JSON.stringify(metadata.subjects?.length ? metadata.subjects : ['epub']),
      managedFilePath: options.managedFilePath,
      contentHash: options.contentHash,
      sizeBytes: BigInt(options.fileSize),
      chapterCount: metadata.chapterCount,
      language: metadata.language,
      publisher: metadata.publisher,
      publishedAt: metadata.publishedAt,
      identifier: metadata.identifier,
      isbn: metadata.isbn,
      importStatus: 'PARSING'
    }
  });
  let coverUrl = DEFAULT_COVER;
  let coverPath: string | null = null;
  try {
    if (metadata.coverPath) {
      const rel = normalize(join(dirname(metadata.opfPath), metadata.coverPath)).replace(/^\/+/, '');
      const coverExt = extname(metadata.coverPath) || '.jpg';
      coverPath = resolve(BOOK_ASSET_ROOT, book.id, `cover${coverExt}`);
      await mkdir(dirname(coverPath), { recursive: true });
      await writeFile(coverPath, await readZipEntry(options.managedFilePath, rel));
      coverUrl = storageUrl(coverPath as string);
    }
    await prisma.$transaction([
      prisma.bookChapter.createMany({ data: metadata.chapters.map((chapter) => ({ bookId: book.id, title: chapter.title, href: chapter.href, mediaType: chapter.mediaType ?? null, sortOrder: chapter.sortOrder })) }),
      prisma.readingUnit.createMany({ data: metadata.chapters.map((chapter) => ({ bookId: book.id, unitType: 'chapter', title: chapter.title, href: chapter.href, filePath: null, mediaType: chapter.mediaType ?? null, sortOrder: chapter.sortOrder, metadataJson: JSON.stringify({ idref: chapter.idref }) })) }),
      ...(coverPath ? [prisma.bookAsset.create({ data: { bookId: book.id, assetType: 'cover', filePath: coverPath, url: coverUrl, mediaType: metadata.coverMediaType ?? null, sortOrder: 0 } })] : []),
      prisma.bookMetadata.create({ data: { bookId: book.id, source: 'epub_opf', rawJson: JSON.stringify(metadata.rawMetadata) } }),
      prisma.bookFile.create({ data: { bookId: book.id, path: options.managedFilePath, filePathHash: createHash('sha256').update(options.managedFilePath).digest('hex'), fingerprint: `full:${options.contentHash}`, fullHash: options.contentHash, hashStatus: 'FULL', kind: 'EPUB', mimeType: 'application/epub+zip', sortOrder: 0, sizeBytes: BigInt(options.fileSize), mtimeMs: BigInt(Math.trunc((await stat(options.managedFilePath)).mtimeMs)) } }),
      prisma.book.update({ where: { id: book.id }, data: { coverPath, coverStatus: coverPath ? 'READY' : 'PENDING', importStatus: 'COMPLETED' } })
    ]);
    return { bookId: book.id, title: metadata.title, type: 'ebook', format: 'epub', totalUnits: metadata.chapterCount, coverUrl, importStatus: 'completed', duplicate: false };
  } catch (error) {
    if (coverPath) await unlink(coverPath).catch(() => undefined);
    await prisma.book.update({ where: { id: book.id }, data: { importStatus: 'FAILED', importError: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    throw error;
  }
}

async function importManagedComic(options: ImportManagedBookOptions & { importTaskId: string; managedFilePath: string; contentHash: string; fileSize: number; ext: string }): Promise<ImportManagedBookResult> {
  const parsed = await parseComicArchive(options.managedFilePath, options.originalName);
  const volume = parseComicVolumeFromName(options.sourceFilePath, options.originalName);
  const targetBook = volume ? await findComicSeriesTarget(options, volume) : null;
  if (volume && targetBook) return appendComicVolumeToBook(targetBook.id, parsed, volume, options);

  const book = await prisma.book.create({
    data: {
      monitorFolderId: options.monitorFolderId ?? null,
      origin: options.origin,
      title: volume?.seriesName ?? parsed.title,
      author: parsed.author,
      description: parsed.description,
      seriesName: volume?.seriesName ?? null,
      seriesIndex: volume?.seriesIndex ?? null,
      format: 'COMIC',
      tags: JSON.stringify(parsed.comicInfo?.tags ?? ['comic', parsed.format]),
      managedFilePath: options.managedFilePath,
      contentHash: options.contentHash,
      sizeBytes: BigInt(options.fileSize),
      pageCount: parsed.pageCount,
      importStatus: 'PARSING'
    }
  });
  let coverPath: string | null = null;
  try {
    const coverExt = extname(parsed.coverEntryPath).toLowerCase() || '.jpg';
    coverPath = resolve(BOOK_ASSET_ROOT, book.id, `cover${coverExt}`);
    await mkdir(dirname(coverPath), { recursive: true });
    await writeFile(coverPath, await readZipEntry(options.managedFilePath, parsed.coverEntryPath));
    const finalCoverPath = coverPath as string;
    const coverUrl = storageUrl(finalCoverPath);
    const managedMtimeMs = BigInt(Math.trunc((await stat(options.managedFilePath)).mtimeMs));
    await prisma.$transaction(async (tx) => {
      const bookFile = await tx.bookFile.create({
        data: {
          bookId: book.id,
          path: options.managedFilePath,
          filePathHash: fileHashForPath(options.managedFilePath),
          fingerprint: `full:${options.contentHash}`,
          fullHash: options.contentHash,
          hashStatus: 'FULL',
          kind: 'COMIC',
          mimeType: comicMimeType(parsed.format),
          sortOrder: volume?.seriesIndex ? Math.trunc(volume.seriesIndex) : 0,
          sizeBytes: BigInt(options.fileSize),
          mtimeMs: managedMtimeMs
        }
      });
      await tx.readingUnit.createMany({
        data: parsed.pages.map((page) => ({
          bookId: book.id,
          unitType: 'page',
          title: page.title,
          href: page.entryPath,
          filePath: bookFile.path,
          mediaType: page.mediaType,
          sortOrder: page.index,
          size: page.size ? BigInt(page.size) : null,
          metadataJson: JSON.stringify({
            zipEntryName: page.entryPath,
            originalName: basename(page.entryPath),
            pageInVolume: page.index,
            pageInSection: page.index,
            volumeIndex: volume?.seriesIndex ?? null,
            sectionId: comicSectionId(bookFile.id),
            sectionTitle: comicSectionTitle(volume),
            sourceFileName: options.originalName ?? basename(options.sourceFilePath),
            bookFileId: bookFile.id
          })
        }))
      });
      await tx.bookAsset.create({ data: { bookId: book.id, assetType: 'cover', filePath: finalCoverPath, url: coverUrl, mediaType: entryMimeType(parsed.coverEntryPath), size: BigInt((await stat(finalCoverPath)).size), sortOrder: 0 } });
      await tx.bookMetadata.create({ data: { bookId: book.id, source: parsed.comicInfo ? 'comic_info' : 'system', rawJson: JSON.stringify(parsed.rawMetadata) } });
      await tx.book.update({ where: { id: book.id }, data: { coverPath, coverStatus: 'READY', importStatus: 'COMPLETED' } });
    });
    await reorderComicBookFilesAndPages(book.id);
    return { bookId: book.id, title: volume?.seriesName ?? parsed.title, type: 'comic', format: parsed.format, totalUnits: parsed.pageCount, coverUrl, importStatus: 'completed', duplicate: false };
  } catch (error) {
    if (coverPath) await unlink(coverPath).catch(() => undefined);
    await prisma.book.update({ where: { id: book.id }, data: { importStatus: 'FAILED', importError: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    throw error;
  }
}

async function appendComicVolumeToBook(
  bookId: string,
  parsed: ParsedComicArchive,
  volume: NonNullable<ParsedComicVolume>,
  options: ImportManagedBookOptions & { importTaskId: string; managedFilePath: string; contentHash: string; fileSize: number; ext: string }
): Promise<ImportManagedBookResult> {
  const mtimeMs = BigInt(Math.trunc((await stat(options.managedFilePath)).mtimeMs));
  await prisma.$transaction(async (tx) => {
    const book = await tx.book.findUnique({
      where: { id: bookId },
      include: { files: { orderBy: { sortOrder: 'asc' } } }
    });
    if (!book) throw new Error('目标漫画不存在');
    if (book.files.some((file) => file.path === options.managedFilePath || file.fullHash === options.contentHash)) return;

    const bookFile = await tx.bookFile.create({
      data: {
        bookId,
        path: options.managedFilePath,
        filePathHash: fileHashForPath(options.managedFilePath),
        fingerprint: `full:${options.contentHash}`,
        fullHash: options.contentHash,
        hashStatus: 'FULL',
        kind: 'COMIC',
        mimeType: comicMimeType(parsed.format),
        sortOrder: Math.trunc(volume?.seriesIndex ?? book.files.length),
        sizeBytes: BigInt(options.fileSize),
        mtimeMs
      }
    });

    await tx.readingUnit.createMany({
      data: parsed.pages.map((page) => ({
        bookId,
        unitType: 'page',
        title: page.title,
        href: page.entryPath,
        filePath: bookFile.path,
        mediaType: page.mediaType,
        sortOrder: (book.pageCount ?? 0) + page.index,
        size: page.size ? BigInt(page.size) : null,
        metadataJson: JSON.stringify({
          zipEntryName: page.entryPath,
          originalName: basename(page.entryPath),
          pageInVolume: page.index,
          pageInSection: page.index,
          volumeIndex: volume?.seriesIndex ?? null,
          sectionId: comicSectionId(bookFile.id),
          sectionTitle: comicSectionTitle(volume),
          sourceFileName: options.originalName ?? basename(options.sourceFilePath),
          bookFileId: bookFile.id
        })
      }))
    });

    await tx.bookMetadata.create({
      data: {
        bookId,
        source: parsed.comicInfo ? 'comic_info' : 'system',
        rawJson: JSON.stringify({
          ...parsed.rawMetadata,
          volumeIndex: volume?.seriesIndex ?? null,
          sourceFileName: options.originalName ?? basename(options.sourceFilePath)
        })
      }
    });

    await tx.book.update({
      where: { id: bookId },
      data: {
        title: book.seriesName ?? volume?.seriesName ?? book.title,
        seriesName: book.seriesName ?? volume?.seriesName ?? null,
        seriesIndex: book.seriesIndex === null ? volume.seriesIndex : Math.min(book.seriesIndex, volume.seriesIndex),
        sizeBytes: book.sizeBytes + BigInt(options.fileSize),
        pageCount: (book.pageCount ?? 0) + parsed.pageCount,
        importStatus: 'COMPLETED'
      }
    });
  });

  await reorderComicBookFilesAndPages(bookId);
  const book = await prisma.book.findUnique({ where: { id: bookId } });
  return {
    bookId,
    title: book?.title ?? volume?.seriesName ?? parsed.title,
    type: 'comic',
    format: parsed.format,
    totalUnits: book?.pageCount ?? parsed.pageCount,
    coverUrl: book?.coverPath ? storageUrl(book.coverPath) : null,
    importStatus: 'completed',
    duplicate: false
  };
}

async function convergeWatchedComicSeries(options: ImportManagedBookOptions, fallbackBookId: string) {
  const volume = parseComicVolumeFromName(options.sourceFilePath, options.originalName);
  const parent = sourceParentPath(options);
  if (!volume || !parent) return null;

  const tasks = await prisma.importTask.findMany({
    where: {
      origin: 'WATCH',
      monitorFolderId: options.monitorFolderId ?? null,
      status: 'COMPLETED',
      sourcePath: { startsWith: parentPrefix(parent) },
      book: { format: 'COMIC', seriesName: volume.seriesName }
    },
    include: {
      book: {
        include: {
          files: { orderBy: { sortOrder: 'asc' } },
          readingUnits: { where: { unitType: 'page' }, orderBy: { sortOrder: 'asc' } }
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  const candidates = tasks
    .filter((task) => task.book && dirname(resolve(task.sourcePath)) === parent)
    .map((task) => ({ task, book: task.book! }));
  if (candidates.length === 0) return null;

  const canonical = [...candidates].sort((left, right) => {
    const leftIndex = left.book.seriesIndex ?? parseComicVolumeFromName(left.task.sourcePath, left.task.originalName ?? undefined)?.seriesIndex ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = right.book.seriesIndex ?? parseComicVolumeFromName(right.task.sourcePath, right.task.originalName ?? undefined)?.seriesIndex ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.book.createdAt.getTime() - right.book.createdAt.getTime();
  })[0].book;

  const sourceBooks = [...new Map(candidates.map((candidate) => [candidate.book.id, candidate.book])).values()].filter((book) => book.id !== canonical.id);
  if (sourceBooks.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const source of sourceBooks) {
        await tx.bookFile.updateMany({ where: { bookId: source.id }, data: { bookId: canonical.id } });
        await tx.readingUnit.updateMany({ where: { bookId: source.id }, data: { bookId: canonical.id } });
        await tx.importTask.updateMany({ where: { bookId: source.id }, data: { bookId: canonical.id } });
        await tx.book.update({ where: { id: source.id }, data: { hidden: true } });
      }
    });
  }

  await reorderComicBookFilesAndPages(canonical.id);
  const merged = await prisma.book.findUnique({ where: { id: canonical.id }, include: { files: true, readingUnits: { where: { unitType: 'page' } } } });
  if (!merged) return null;
  const sizeBytes = merged.files.reduce((total, file) => total + BigInt(file.sizeBytes), BigInt(0));
  const minSeriesIndex = Math.min(...merged.files.map((file) => parseComicVolumeFromName(file.path)?.seriesIndex ?? Number.MAX_SAFE_INTEGER).filter(Number.isFinite));
  await prisma.book.update({
    where: { id: merged.id },
    data: {
      title: volume.seriesName,
      seriesName: volume.seriesName,
      seriesIndex: Number.isFinite(minSeriesIndex) ? minSeriesIndex : merged.seriesIndex,
      sizeBytes,
      pageCount: merged.readingUnits.length,
      importStatus: 'COMPLETED'
    }
  });
  await prisma.importTask.updateMany({ where: { id: { in: candidates.map((candidate) => candidate.task.id) } }, data: { bookId: merged.id } });
  return { bookId: merged.id, title: volume.seriesName, totalUnits: merged.readingUnits.length };
}

export function isSupportedImportFile(filePath: string) {
  return supportedExts.has(extname(filePath).toLowerCase());
}

export function managedLibraryRoot() {
  return LIBRARY_STORAGE_ROOT;
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, posix, resolve } from 'node:path';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { prisma } from './prisma';

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? '/storage';
const MAX_ARCHIVE_SIZE_BYTES = Number(process.env.COMIC_MAX_ARCHIVE_SIZE_BYTES ?? 2 * 1024 * 1024 * 1024);
const MAX_ENTRIES = Number(process.env.COMIC_MAX_ENTRIES ?? 10000);
const MAX_IMAGE_COUNT = Number(process.env.COMIC_MAX_IMAGE_COUNT ?? 5000);
const MAX_SINGLE_IMAGE_BYTES = Number(process.env.COMIC_MAX_SINGLE_IMAGE_BYTES ?? 80 * 1024 * 1024);
const XML_MAX_BYTES = Number(process.env.COMIC_INFO_MAX_BYTES ?? 2 * 1024 * 1024);

const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const archiveExts = new Set(['.cbz', '.zip']);
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

export interface ParsedComicPage {
  index: number;
  title: string;
  entryPath: string;
  mediaType: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface ParsedComicInfo {
  title?: string;
  series?: string;
  number?: string;
  volume?: string;
  summary?: string;
  writer?: string;
  penciller?: string;
  inker?: string;
  colorist?: string;
  publisher?: string;
  genre?: string;
  tags?: string[];
  pageCount?: number;
  manga?: string;
  year?: number;
  month?: number;
  day?: number;
  coverImageIndex?: number;
  raw: Record<string, unknown>;
}

export interface ParsedComicArchive {
  title: string;
  author: string;
  description?: string | null;
  format: 'cbz' | 'zip';
  pageCount: number;
  coverEntryPath: string;
  pages: ParsedComicPage[];
  comicInfo?: ParsedComicInfo | null;
  rawMetadata: Record<string, unknown>;
}

export interface ImportComicOptions {
  filePath: string;
  originalName?: string;
  libraryPathId?: string;
}

export interface ImportComicResult {
  bookId: string;
  title: string;
  type: 'comic';
  format: 'cbz' | 'zip';
  totalUnits: number;
  coverUrl?: string | null;
  importStatus: 'completed' | 'failed';
}

type ZipEntrySummary = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
};

function entryMimeType(name: string) {
  const ext = extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function archiveFormat(filePath: string): 'cbz' | 'zip' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.cbz') return 'cbz';
  if (ext === '.zip') return 'zip';
  throw new Error('当前版本仅支持 EPUB、CBZ、ZIP 格式。');
}

function titleFromFile(filePath: string, originalName?: string) {
  const source = originalName || basename(filePath);
  return basename(source, extname(source)).replaceAll('_', ' ').replaceAll('-', ' ').trim() || basename(source);
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
    yauzl.open(path, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zipFile) => {
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

async function listArchiveEntries(filePath: string) {
  const zipFile = await openZip(filePath);
  return new Promise<{ images: ZipEntrySummary[]; comicInfoEntry?: ZipEntrySummary }>((resolveEntries, reject) => {
    const images: ZipEntrySummary[] = [];
    let comicInfoEntry: ZipEntrySummary | undefined;
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
        if (safeName.toLowerCase().endsWith('comicinfo.xml') && entry.uncompressedSize <= XML_MAX_BYTES) {
          comicInfoEntry = { name: safeName, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize };
        } else if (isImageEntry(safeName)) {
          if (entry.uncompressedSize > MAX_SINGLE_IMAGE_BYTES) {
            closeZip(zipFile);
            reject(new Error(`单张图片超过限制（${MAX_SINGLE_IMAGE_BYTES} bytes）：${safeName}`));
            return;
          }
          images.push({ name: safeName, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize });
        }
      }
      zipFile.readEntry();
    });
    zipFile.once('end', () => {
      closeZip(zipFile);
      resolveEntries({ images, comicInfoEntry });
    });
    zipFile.once('error', (error) => {
      closeZip(zipFile);
      reject(error);
    });
    zipFile.readEntry();
  });
}

function readZipEntry(filePath: string, entryName: string) {
  return new Promise<Buffer>((resolveBuffer, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (openError, zipFile) => {
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
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('ZIP 条目读取失败'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
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

function xmlText(xml: string, tag: string) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!match) return undefined;
  return decodeXml(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || undefined;
}

function decodeXml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function numericXml(xml: string, tag: string) {
  const value = xmlText(xml, tag);
  const numberValue = value ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function parseComicInfoXml(xmlInput: string): ParsedComicInfo {
  const xml = xmlInput.replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!ENTITY[\s\S]*?>/gi, '');
  const raw: Record<string, unknown> = {};
  for (const tag of ['Title', 'Series', 'Number', 'Volume', 'Summary', 'Writer', 'Penciller', 'Inker', 'Colorist', 'Publisher', 'Genre', 'Tags', 'PageCount', 'Manga', 'Year', 'Month', 'Day']) {
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
    number: xmlText(xml, 'Number'),
    volume: xmlText(xml, 'Volume'),
    summary: xmlText(xml, 'Summary'),
    writer: xmlText(xml, 'Writer'),
    penciller: xmlText(xml, 'Penciller'),
    inker: xmlText(xml, 'Inker'),
    colorist: xmlText(xml, 'Colorist'),
    publisher: xmlText(xml, 'Publisher'),
    genre: xmlText(xml, 'Genre'),
    tags: (xmlText(xml, 'Tags') ?? xmlText(xml, 'Genre'))?.split(/[,，;]/).map((tag) => tag.trim()).filter(Boolean),
    pageCount: numericXml(xml, 'PageCount'),
    manga: xmlText(xml, 'Manga'),
    year: numericXml(xml, 'Year'),
    month: numericXml(xml, 'Month'),
    day: numericXml(xml, 'Day'),
    coverImageIndex: Number.isFinite(coverImageIndex) ? coverImageIndex : undefined,
    raw
  };
}

function chooseCover(pages: ParsedComicPage[], comicInfo?: ParsedComicInfo | null) {
  if (comicInfo?.coverImageIndex !== undefined) {
    const byComicInfo = pages.find((page) => page.index - 1 === comicInfo.coverImageIndex || page.index === comicInfo.coverImageIndex);
    if (byComicInfo) return byComicInfo.entryPath;
  }
  const namedCover = pages.find((page) => /(cover|folder|front|封面)/i.test(basename(page.entryPath)));
  return namedCover?.entryPath ?? pages[0]?.entryPath;
}

export async function parseComicArchive(filePath: string, originalName?: string): Promise<ParsedComicArchive> {
  const format = archiveFormat(filePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error('漫画压缩包不存在或不可读');
  if (fileStat.size > MAX_ARCHIVE_SIZE_BYTES) throw new Error(`漫画压缩包超过限制（${MAX_ARCHIVE_SIZE_BYTES} bytes）`);

  const { images, comicInfoEntry } = await listArchiveEntries(filePath);
  if (images.length === 0) throw new Error('漫画压缩包内没有可导入的图片');
  if (images.length > MAX_IMAGE_COUNT) throw new Error(`漫画图片数量超过限制（${MAX_IMAGE_COUNT}）`);

  images.sort((left, right) => collator.compare(left.name, right.name));
  let comicInfo: ParsedComicInfo | null = null;
  if (comicInfoEntry) {
    try {
      comicInfo = parseComicInfoXml((await readZipEntry(filePath, comicInfoEntry.name)).toString('utf8'));
    } catch (error) {
      console.warn('[comic-info-parse-error]', { filePath, error });
    }
  }

  const pages = images.map<ParsedComicPage>((entry, index) => ({
    index: index + 1,
    title: `第 ${index + 1} 页`,
    entryPath: entry.name,
    mediaType: entryMimeType(entry.name),
    size: entry.uncompressedSize
  }));
  const title = comicInfo?.title || titleFromFile(filePath, originalName);
  const author = comicInfo?.writer || comicInfo?.penciller || '未知作者';
  const coverEntryPath = chooseCover(pages, comicInfo);
  if (!coverEntryPath) throw new Error('漫画压缩包内没有可用封面');

  const imageFormats = [...new Set(pages.map((page) => extname(page.entryPath).toLowerCase().replace(/^\./, '')))].sort();
  return {
    title,
    author,
    description: comicInfo?.summary ?? null,
    format,
    pageCount: pages.length,
    coverEntryPath,
    pages,
    comicInfo,
    rawMetadata: comicInfo
      ? { hasComicInfo: true, comicInfo: comicInfo.raw, pageCount: pages.length, imageFormats, coverEntryPath }
      : { hasComicInfo: false, pageCount: pages.length, imageFormats, coverEntryPath }
  };
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

export async function streamComicPageFromArchive(filePath: string, entryPath: string) {
  const safePath = safeEntryName(entryPath);
  if (!safePath || safePath !== entryPath || !isImageEntry(safePath)) throw new Error('漫画页面路径不安全');
  return new Promise<{ zipFile: yauzl.ZipFile; stream: Readable; size: number; mediaType: string }>((resolveStream, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('ZIP 打开失败'));
        return;
      }
      const fail = (error: Error) => {
        closeZip(zipFile);
        reject(error);
      };
      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryPath) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('ZIP 页面读取失败'));
            return;
          }
          resolveStream({ zipFile, stream, size: entry.uncompressedSize, mediaType: entryMimeType(entry.fileName) });
        });
      });
      zipFile.once('end', () => fail(new Error('ZIP 页面不存在')));
      zipFile.once('error', fail);
      zipFile.readEntry();
    });
  });
}

export function closeComicArchive(zipFile: yauzl.ZipFile) {
  closeZip(zipFile);
}

export async function importComicArchive(options: ImportComicOptions): Promise<ImportComicResult> {
  const parsed = await parseComicArchive(options.filePath, options.originalName);
  const fileStat = await stat(options.filePath);
  const fullHash = await sha256File(options.filePath);
  const book = await prisma.book.create({
    data: {
      libraryPathId: options.libraryPathId,
      title: parsed.title,
      author: parsed.author,
      description: parsed.description,
      format: 'COMIC',
      tags: JSON.stringify(parsed.comicInfo?.tags ?? ['comic', parsed.format]),
      sourcePath: options.filePath,
      sourceHash: `comic:${fullHash}`,
      sizeBytes: BigInt(fileStat.size),
      pageCount: parsed.pageCount,
      importStatus: 'PARSING'
    }
  });

  let coverPath: string | null = null;
  try {
    const coverExt = extname(parsed.coverEntryPath).toLowerCase() || '.jpg';
    coverPath = resolve(STORAGE_ROOT, 'books', book.id, `cover${coverExt}`);
    await mkdir(join(STORAGE_ROOT, 'books', book.id), { recursive: true });
    await writeFile(coverPath, await readZipEntry(options.filePath, parsed.coverEntryPath));
    const coverUrl = `/storage/books/${book.id}/cover${coverExt}`;

    await prisma.$transaction([
      prisma.readingUnit.createMany({
        data: parsed.pages.map((page) => ({
          bookId: book.id,
          unitType: 'page',
          title: page.title,
          href: page.entryPath,
          filePath: null,
          mediaType: page.mediaType,
          sortOrder: page.index,
          width: page.width ?? null,
          height: page.height ?? null,
          size: page.size ? BigInt(page.size) : null,
          metadataJson: JSON.stringify({ zipEntryName: page.entryPath, originalName: basename(page.entryPath) })
        }))
      }),
      // 页面图片已经由 reading_units.href 完整索引；MVP 阶段只落库封面 asset，避免为大漫画重复写入数千条 asset 记录。
      prisma.bookAsset.create({
        data: {
          bookId: book.id,
          assetType: 'cover',
          filePath: coverPath,
          url: coverUrl,
          mediaType: entryMimeType(parsed.coverEntryPath),
          size: BigInt((await stat(coverPath)).size),
          sortOrder: 0
        }
      }),
      prisma.bookMetadata.create({
        data: {
          bookId: book.id,
          source: parsed.comicInfo ? 'comic_info' : 'system',
          rawJson: JSON.stringify(parsed.rawMetadata)
        }
      }),
      prisma.bookFile.create({
        data: {
          bookId: book.id,
          path: options.filePath,
          filePathHash: createHash('sha256').update(options.filePath).digest('hex'),
          fingerprint: `full:${fullHash}`,
          fullHash,
          hashStatus: 'FULL',
          kind: 'COMIC',
          mimeType: parsed.format === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/zip',
          sortOrder: 0,
          sizeBytes: BigInt(fileStat.size),
          mtimeMs: BigInt(Math.trunc(fileStat.mtimeMs))
        }
      }),
      prisma.book.update({
        where: { id: book.id },
        data: { coverPath, coverStatus: 'READY', importStatus: 'COMPLETED' }
      })
    ]);

    return { bookId: book.id, title: parsed.title, type: 'comic', format: parsed.format, totalUnits: parsed.pageCount, coverUrl, importStatus: 'completed' };
  } catch (error) {
    if (coverPath) await unlink(coverPath).catch(() => undefined);
    await prisma.book.update({ where: { id: book.id }, data: { importStatus: 'FAILED', importError: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    throw error;
  }
}

export function isSupportedComicArchive(filePath: string) {
  return archiveExts.has(extname(filePath).toLowerCase());
}

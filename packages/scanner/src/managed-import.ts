import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, posix, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { prisma } from '@shuku/database';
import type { BookOrigin } from '@prisma/client';

const DEFAULT_COVER = '/covers/default.svg';
const STORAGE_ROOT = process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage');
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
  title: string;
  type: 'ebook' | 'comic';
  format: 'epub' | 'cbz' | 'zip';
  totalUnits: number;
  coverUrl?: string | null;
  importStatus: 'completed' | 'failed';
  duplicate: boolean;
};

type ParsedEpubChapter = { title: string; href: string; idref?: string; mediaType?: string; sortOrder: number };
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

function textTag(xml: string, tag: string) {
  return Array.from(xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')))
    .map((match) => match[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
}

function attrsFromTag(xml: string, name: string) {
  return Array.from(xml.matchAll(new RegExp(`<${name}\\b([^>]*)/?>(?:</${name}>)?`, 'gi'))).map((match) =>
    Object.fromEntries(Array.from(match[1].matchAll(/([\w:-]+)="([^"]*)"/g)).map((attr) => [attr[1], attr[2]]))
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
  const chapterMap = new Map(manifestItems.map((item) => [item.id, item]));
  const chapters = spineRefs
    .map((ref, index) => {
      const item = chapterMap.get(ref.idref);
      return { title: `第 ${index + 1} 章`, href: item?.href ?? '', idref: ref.idref, mediaType: item?.mediaType, sortOrder: index + 1 };
    })
    .filter((chapter) => chapter.href);
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
  for (const tag of ['Title', 'Summary', 'Writer', 'Penciller', 'Publisher', 'Genre', 'Tags']) {
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
    const duplicate = await prisma.book.findUnique({ where: { contentHash } });
    if (duplicate) {
      await prisma.importTask.update({
        where: { id: importTaskId },
        data: {
          bookId: duplicate.id,
          status: 'COMPLETED',
          progress: 100,
          duplicate: true,
          contentHash,
          managedFilePath: duplicate.managedFilePath,
          message: '读物已存在，跳过重复导入',
          duration: Date.now() - startedAt,
          finishedAt: new Date()
        }
      });
      await logImport(importTaskId, 'info', `duplicate: ${duplicate.id}`);
      return {
        bookId: duplicate.id,
        title: duplicate.title,
        type: duplicate.format === 'COMIC' ? 'comic' : 'ebook',
        format: ext === '.epub' ? 'epub' : ext === '.cbz' ? 'cbz' : 'zip',
        totalUnits: duplicate.format === 'COMIC' ? duplicate.pageCount ?? 0 : duplicate.chapterCount ?? 0,
        coverUrl: duplicate.coverPath ? storageUrl(duplicate.coverPath) : null,
        importStatus: 'completed',
        duplicate: true
      };
    }

    await copyFile(options.sourceFilePath, managedFilePath);
    await prisma.importTask.update({ where: { id: importTaskId }, data: { progress: 30, contentHash, managedFilePath, message: '正在读取元数据' } });

    const result = ext === '.epub'
      ? await importManagedEpub({ ...options, importTaskId, managedFilePath, contentHash, fileSize: fileStat.size })
      : await importManagedComic({ ...options, importTaskId, managedFilePath, contentHash, fileSize: fileStat.size, ext });

    await prisma.importTask.update({
      where: { id: importTaskId },
      data: { bookId: result.bookId, status: 'COMPLETED', progress: 100, duplicate: false, message: '导入完成', duration: Date.now() - startedAt, finishedAt: new Date() }
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
  const book = await prisma.book.create({
    data: {
      monitorFolderId: options.monitorFolderId ?? null,
      origin: options.origin,
      title: parsed.title,
      author: parsed.author,
      description: parsed.description,
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
          size: page.size ? BigInt(page.size) : null,
          metadataJson: JSON.stringify({ zipEntryName: page.entryPath, originalName: basename(page.entryPath) })
        }))
      }),
      prisma.bookAsset.create({ data: { bookId: book.id, assetType: 'cover', filePath: finalCoverPath, url: coverUrl, mediaType: entryMimeType(parsed.coverEntryPath), size: BigInt((await stat(finalCoverPath)).size), sortOrder: 0 } }),
      prisma.bookMetadata.create({ data: { bookId: book.id, source: parsed.comicInfo ? 'comic_info' : 'system', rawJson: JSON.stringify(parsed.rawMetadata) } }),
      prisma.bookFile.create({ data: { bookId: book.id, path: options.managedFilePath, filePathHash: createHash('sha256').update(options.managedFilePath).digest('hex'), fingerprint: `full:${options.contentHash}`, fullHash: options.contentHash, hashStatus: 'FULL', kind: 'COMIC', mimeType: parsed.format === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/zip', sortOrder: 0, sizeBytes: BigInt(options.fileSize), mtimeMs: BigInt(Math.trunc((await stat(options.managedFilePath)).mtimeMs)) } }),
      prisma.book.update({ where: { id: book.id }, data: { coverPath, coverStatus: 'READY', importStatus: 'COMPLETED' } })
    ]);
    return { bookId: book.id, title: parsed.title, type: 'comic', format: parsed.format, totalUnits: parsed.pageCount, coverUrl, importStatus: 'completed', duplicate: false };
  } catch (error) {
    if (coverPath) await unlink(coverPath).catch(() => undefined);
    await prisma.book.update({ where: { id: book.id }, data: { importStatus: 'FAILED', importError: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    throw error;
  }
}

export function isSupportedImportFile(filePath: string) {
  return supportedExts.has(extname(filePath).toLowerCase());
}

export function managedLibraryRoot() {
  return LIBRARY_STORAGE_ROOT;
}

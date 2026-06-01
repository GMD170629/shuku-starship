import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import {
  acquireStreamSlot,
  attachStreamAccounting,
  contentTypes,
  isImageMimeType,
  notModified,
  tooManyStreamsResponse,
  weakEtag
} from './file-response';

const INDEX_VERSION = 1;
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const generationLocks = new Map<string, Promise<ArchivePageIndex>>();
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

export type ArchivePage = {
  pageIndex: number;
  name: string;
  mimeType: string;
  compressedSize?: number;
  uncompressedSize?: number;
};

export type ArchivePageIndex = {
  version: number;
  bookId: string;
  fileId: string;
  source: {
    size: number;
    mtimeMs: number;
  };
  pages: ArchivePage[];
  createdAt: string;
};

type EntrySummary = {
  name: string;
  compressedSize?: number;
  uncompressedSize?: number;
};

function storageRoot() {
  return process.env.STORAGE_ROOT || process.env.STORAGE_DIR || join(process.cwd(), 'storage');
}

function indexDir() {
  return join(storageRoot(), 'indexes');
}

function safeSegment(input: string) {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function archiveIndexPath(bookId: string, fileId: string, size: number, mtimeMs: number) {
  return join(indexDir(), `${safeSegment(bookId)}-${safeSegment(fileId)}-${size}-${Math.trunc(mtimeMs)}.json`);
}

function entryMimeType(name: string) {
  return contentTypes[extname(name).toLowerCase()] || 'application/octet-stream';
}

function isImageEntry(name: string) {
  return imageExts.has(extname(name).toLowerCase()) && !name.startsWith('__MACOSX/');
}

function openZip(path: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('ZIP 打开失败'));
      else resolve(zipFile);
    });
  });
}

function closeZip(zipFile: yauzl.ZipFile) {
  try {
    zipFile.close();
  } catch {
    // yauzl may already have closed the descriptor after an error.
  }
}

async function listImageEntries(path: string) {
  const zipFile = await openZip(path);
  return new Promise<EntrySummary[]>((resolve, reject) => {
    const entries: EntrySummary[] = [];

    zipFile.on('entry', (entry: yauzl.Entry) => {
      if (!/\/$/.test(entry.fileName) && isImageEntry(entry.fileName) && isImageMimeType(entryMimeType(entry.fileName))) {
        entries.push({
          name: entry.fileName,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize
        });
      }
      zipFile.readEntry();
    });

    zipFile.once('end', () => {
      closeZip(zipFile);
      resolve(entries);
    });
    zipFile.once('error', (error) => {
      closeZip(zipFile);
      reject(error);
    });
    zipFile.readEntry();
  });
}

async function readCachedIndex(path: string, bookId: string, fileId: string, size: number, mtimeMs: number) {
  const payload = await readFile(path, 'utf8').catch(() => null);
  if (!payload) return null;
  try {
    const index = JSON.parse(payload) as ArchivePageIndex;
    if (
      index.version === INDEX_VERSION &&
      index.bookId === bookId &&
      index.fileId === fileId &&
      index.source.size === size &&
      Math.trunc(index.source.mtimeMs) === Math.trunc(mtimeMs) &&
      Array.isArray(index.pages)
    ) {
      return index;
    }
  } catch {
    return null;
  }
  return null;
}

async function buildArchiveIndex(bookId: string, fileId: string, path: string, size: number, mtimeMs: number) {
  const entries = await listImageEntries(path);
  entries.sort((left, right) => collator.compare(left.name, right.name));
  const pages = entries.map((entry, index) => ({
    pageIndex: index + 1,
    name: entry.name,
    mimeType: entryMimeType(entry.name),
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize
  }));
  const pageIndex: ArchivePageIndex = {
    version: INDEX_VERSION,
    bookId,
    fileId,
    source: { size, mtimeMs: Math.trunc(mtimeMs) },
    pages,
    createdAt: new Date().toISOString()
  };

  await mkdir(indexDir(), { recursive: true });
  await writeFile(archiveIndexPath(bookId, fileId, size, mtimeMs), JSON.stringify(pageIndex, null, 2));
  return pageIndex;
}

export async function ensureArchiveIndex(bookId: string, fileId: string, path: string) {
  const fileStat = await stat(path);
  const cachePath = archiveIndexPath(bookId, fileId, fileStat.size, fileStat.mtimeMs);
  const cached = await readCachedIndex(cachePath, bookId, fileId, fileStat.size, fileStat.mtimeMs);
  if (cached) return cached;

  const lockKey = `${bookId}:${fileId}:${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`;
  const existing = generationLocks.get(lockKey);
  if (existing) return existing;

  const pending = buildArchiveIndex(bookId, fileId, path, fileStat.size, fileStat.mtimeMs).finally(() => {
    generationLocks.delete(lockKey);
  });
  generationLocks.set(lockKey, pending);
  return pending;
}

function findEntryStream(path: string, entryName: string) {
  return new Promise<{ zipFile: yauzl.ZipFile; entry: yauzl.Entry; stream: Readable }>((resolve, reject) => {
    let settled = false;
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('ZIP 打开失败'));
        return;
      }

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
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
            fail(streamError ?? new Error('ZIP 页面读取失败'));
            return;
          }
          settled = true;
          resolve({ zipFile, entry, stream });
        });
      });

      zipFile.once('end', () => fail(new Error('ZIP 页面不存在')));
      zipFile.once('error', fail);
      zipFile.readEntry();
    });
  });
}

export function archivePageEtag(index: ArchivePageIndex, page: ArchivePage) {
  const digest = createHash('sha1').update(`${page.pageIndex}:${page.name}:${page.uncompressedSize ?? ''}`).digest('hex').slice(0, 12);
  return weakEtag(index.source.size, index.source.mtimeMs, digest);
}

export async function streamArchivePageResponse(options: {
  request: Request;
  userId: string;
  bookId: string;
  fileId: string;
  path: string;
  index: ArchivePageIndex;
  pageIndex: number;
}) {
  const { request, userId, bookId, fileId, path, index, pageIndex } = options;
  const page = index.pages.find((item) => item.pageIndex === pageIndex);
  if (!page) {
    return Response.json({ ok: false, error: { message: '页面不存在' } }, { status: 404 });
  }

  const etag = archivePageEtag(index, page);
  const archiveStat = await stat(path);
  const lastModified = archiveStat.mtime.toUTCString();
  const headers = {
    'Content-Type': page.mimeType,
    'Cache-Control': 'private, max-age=86400',
    ETag: etag,
    'Last-Modified': lastModified
  };

  if (notModified(request, etag, lastModified)) {
    return new Response(null, { status: 304, headers });
  }

  const release = acquireStreamSlot(userId);
  if (!release) return tooManyStreamsResponse();

  try {
    const { zipFile, entry, stream } = await findEntryStream(path, page.name);
    const close = () => closeZip(zipFile);
    stream.once('close', close);
    stream.once('end', close);
    stream.once('error', close);
    attachStreamAccounting(stream, release, {
      route: '/api/volumes/[id]/pages/[pageIndex]',
      userId,
      bookId,
      fileId,
      bytes: entry.uncompressedSize,
      status: 200,
      startedAt: Date.now()
    });

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        ...headers,
        'Content-Length': String(entry.uncompressedSize)
      }
    });
  } catch (error) {
    release();
    console.error('[archive-page-stream-error]', { bookId, fileId, pageIndex, error });
    return Response.json({ ok: false, error: { message: '漫画页面读取失败' } }, { status: 500 });
  }
}

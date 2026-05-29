import { extname, normalize, posix } from 'node:path';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';

const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function closeZip(zipFile: yauzl.ZipFile) {
  try {
    zipFile.close();
  } catch {
    // yauzl may have already closed the descriptor.
  }
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

function entryMimeType(name: string) {
  const ext = extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
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
      zipFile.on('entry', (entry) => {
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

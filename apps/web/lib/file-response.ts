import { createReadStream, type ReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

export const contentTypes: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif'
};

export type ByteRange = {
  start: number;
  end: number;
};

export type RangeParseResult =
  | { type: 'none' }
  | { type: 'invalid' }
  | { type: 'unsatisfiable' }
  | { type: 'range'; range: ByteRange };

const activeStreamsByUser = new Map<string, number>();

function numberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseByteRange(header: string | null, size: number): RangeParseResult {
  if (!header) return { type: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { type: 'invalid' };

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { type: 'invalid' };
  if (size <= 0) return { type: 'unsatisfiable' };

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { type: 'unsatisfiable' };
    const start = Math.max(0, size - suffixLength);
    return { type: 'range', range: { start, end: size - 1 } };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return { type: 'unsatisfiable' };
  }

  return { type: 'range', range: { start, end: Math.min(end, size - 1) } };
}

export function weakEtag(size: number, mtimeMs: number, extra = '') {
  const suffix = extra ? `-${Buffer.from(extra).toString('base64url')}` : '';
  return `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}${suffix}"`;
}

export function isImageMimeType(mimeType: string) {
  return mimeType.toLowerCase().startsWith('image/');
}

export function mimeTypeForPath(path: string, fallback = 'application/octet-stream') {
  return contentTypes[extname(path).toLowerCase()] || fallback;
}

export function notModified(request: Request, etag: string, lastModified: string) {
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch) {
    const tags = ifNoneMatch.split(',').map((tag) => tag.trim());
    if (tags.includes('*') || tags.includes(etag)) return true;
  }

  const ifModifiedSince = request.headers.get('if-modified-since');
  if (!ifNoneMatch && ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    const modified = Date.parse(lastModified);
    if (Number.isFinite(since) && Number.isFinite(modified) && modified <= since) return true;
  }

  return false;
}

export function shouldUseRange(request: Request, etag: string, lastModified: string) {
  const ifRange = request.headers.get('if-range');
  if (!ifRange) return true;
  if (ifRange.startsWith('W/') || ifRange.startsWith('"')) return ifRange === etag;

  const ifRangeDate = Date.parse(ifRange);
  const modified = Date.parse(lastModified);
  return Number.isFinite(ifRangeDate) && Number.isFinite(modified) && modified <= ifRangeDate;
}

export function acquireStreamSlot(userId: string) {
  const limit = numberFromEnv('FILE_STREAMS_PER_USER', 4);
  const current = activeStreamsByUser.get(userId) ?? 0;
  if (current >= limit) return null;
  activeStreamsByUser.set(userId, current + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (activeStreamsByUser.get(userId) ?? 1) - 1);
    if (next === 0) activeStreamsByUser.delete(userId);
    else activeStreamsByUser.set(userId, next);
  };
}

export function tooManyStreamsResponse() {
  return Response.json({ ok: false, error: { message: '同时文件流请求过多，请稍后重试' } }, { status: 429 });
}

export function rangeErrorResponse(size: number, message = 'Range 超出文件大小') {
  return Response.json(
    { ok: false, error: { message } },
    {
      status: 416,
      headers: {
        'Content-Range': `bytes */${size}`
      }
    }
  );
}

export type SlowRequestInfo = {
  route: string;
  userId: string;
  bookId?: string;
  fileId?: string;
  range?: string | null;
  bytes?: number;
  status: number;
  startedAt: number;
};

export function logSlowRequest(info: SlowRequestInfo) {
  const threshold = numberFromEnv('SLOW_FILE_REQUEST_MS', 1500);
  const durationMs = Date.now() - info.startedAt;
  if (durationMs < threshold) return;
  console.warn('[slow-file-request]', {
    route: info.route,
    userId: info.userId,
    bookId: info.bookId,
    fileId: info.fileId,
    range: info.range,
    bytes: info.bytes,
    status: info.status,
    durationMs
  });
}

export function attachStreamAccounting(stream: ReadStream | Readable, release: () => void, slowInfo: SlowRequestInfo) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
    logSlowRequest(slowInfo);
  };
  stream.once('close', finish);
  stream.once('end', finish);
  stream.once('error', finish);
}

export function streamFileResponse(options: {
  request: Request;
  userId: string;
  route: string;
  bookId?: string;
  fileId: string;
  path: string;
  stat: Stats;
  mimeType: string;
  downloadName: string;
}) {
  const { request, userId, route, bookId, fileId, path, stat, mimeType, downloadName } = options;
  const size = stat.size;
  const etag = weakEtag(size, stat.mtimeMs);
  const lastModified = stat.mtime.toUTCString();
  const rangeHeader = request.headers.get('range');
  const cacheControl = isImageMimeType(mimeType) ? 'private, max-age=86400' : 'private, max-age=60';
  const baseHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mimeType,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    'Cache-Control': cacheControl,
    ETag: etag,
    'Last-Modified': lastModified
  };

  if (!rangeHeader && notModified(request, etag, lastModified)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  let range: ByteRange | null = null;
  if (rangeHeader && shouldUseRange(request, etag, lastModified)) {
    const parsed = parseByteRange(rangeHeader, size);
    if (parsed.type === 'invalid') return rangeErrorResponse(size, 'Range 请求格式不正确');
    if (parsed.type === 'unsatisfiable') return rangeErrorResponse(size);
    if (parsed.type === 'range') range = parsed.range;
  }

  const release = acquireStreamSlot(userId);
  if (!release) return tooManyStreamsResponse();

  try {
    const stream = range ? createReadStream(path, { start: range.start, end: range.end }) : createReadStream(path);
    const status = range ? 206 : 200;
    const bytes = range ? range.end - range.start + 1 : size;
    attachStreamAccounting(stream, release, {
      route,
      userId,
      bookId,
      fileId,
      range: rangeHeader,
      bytes,
      status,
      startedAt: Date.now()
    });

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status,
      headers: {
        ...baseHeaders,
        'Content-Length': String(bytes),
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {})
      }
    });
  } catch (error) {
    release();
    console.error('[file-stream-error]', { route, userId, bookId, fileId, error });
    return Response.json({ ok: false, error: { message: '文件读取失败' } }, { status: 500 });
  }
}

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { CoverService, type CoverSize } from '@shuku/scanner/cover-service';
import { requireUser } from '../../../../../lib/auth';
import { fail } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

const coverSizes = new Set<CoverSize>(['small', 'medium', 'large']);

function coverContentType(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

async function readableCoverPath(bookId: string, size: CoverSize) {
  const path = CoverService.coverPathFor(bookId, size);
  const fileStat = await stat(path).catch(() => null);
  return fileStat?.isFile() ? { path, size: fileStat.size } : null;
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const url = new URL(request.url);
  const requestedSize = url.searchParams.get('size') ?? 'medium';
  if (!coverSizes.has(requestedSize as CoverSize)) return fail('封面尺寸不正确', 400);
  const size = requestedSize as CoverSize;

  const book = await prisma.book.findFirst({
    where: { id: params.id, hidden: false },
    include: { files: { orderBy: { sortOrder: 'asc' } } }
  });
  if (!book) return fail('读物不存在或无权访问', 404);

  let cover = book.coverPath ? await stat(book.coverPath).then((fileStat) => fileStat.isFile() ? { path: book.coverPath as string, size: fileStat.size } : null).catch(() => null) : null;
  if (!cover) cover = await readableCoverPath(params.id, size);
  if (!cover) {
    await CoverService.ensureBookCover(book);
    cover = await readableCoverPath(params.id, size);
  }

  if (!cover) return fail('封面不可用', 404);
  const stream = createReadStream(cover.path);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': coverContentType(cover.path),
      'Content-Length': String(cover.size),
      'Cache-Control': 'private, max-age=86400'
    }
  });
}

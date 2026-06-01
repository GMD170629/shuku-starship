import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { requireUser } from '../../../../../lib/auth';
import { fail } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

type CoverSize = 'small' | 'medium' | 'large';
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

export async function GET(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const url = new URL(request.url);
  const requestedSize = url.searchParams.get('size') ?? 'medium';
  if (!coverSizes.has(requestedSize as CoverSize)) return fail('封面尺寸不正确', 400);

  const work = await prisma.libraryWork.findFirst({
    where: { id: params.id, hidden: false },
    include: { editions: { where: { hidden: false }, include: { files: { orderBy: { sortOrder: 'asc' } } } } }
  });
  if (!work) return fail('读物不存在或无权访问', 404);

  let cover = work.coverPath ? await stat(work.coverPath).then((fileStat) => fileStat.isFile() ? { path: work.coverPath as string, size: fileStat.size } : null).catch(() => null) : null;
  const primary = work.editions.find((edition) => edition.id === work.primaryEditionId) ?? work.editions[0];
  if (!cover && primary?.coverPath) cover = await stat(primary.coverPath).then((fileStat) => fileStat.isFile() ? { path: primary.coverPath as string, size: fileStat.size } : null).catch(() => null);

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

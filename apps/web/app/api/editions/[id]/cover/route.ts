import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { requireUser } from '../../../../../lib/auth';
import { fail } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const edition = await prisma.libraryEdition.findFirst({
    where: { id: params.id, hidden: false, work: { hidden: false } },
    include: { work: true }
  });
  if (!edition) return fail('版本不存在或无权访问', 404);
  const coverPath = edition.coverPath ?? edition.work.coverPath;
  if (!coverPath) return fail('封面不存在', 404);
  const fileStat = await stat(coverPath).catch(() => null);
  if (!fileStat?.isFile()) return fail('封面不存在', 404);
  return new Response(Readable.toWeb(createReadStream(coverPath)) as ReadableStream, {
    headers: {
      'Content-Type': coverPath.endsWith('.png') ? 'image/png' : coverPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'private, max-age=86400'
    }
  });
}

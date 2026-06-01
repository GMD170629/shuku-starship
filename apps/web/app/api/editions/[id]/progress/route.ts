import { requireUser } from '../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

function safeExtra(extra: unknown) {
  if (typeof extra === 'string') return extra;
  return JSON.stringify(extra ?? {});
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const progress = await prisma.libraryReadingProgress.findUnique({
    where: { userId_editionId: { userId: user.id, editionId: params.id } }
  });
  return ok({ progress });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const body = await readJson<{ readerType?: string; position?: string; page?: number; percent?: number; extra?: unknown }>(request);
  const edition = await prisma.libraryEdition.findFirst({
    where: { id: params.id, hidden: false, work: { hidden: false } },
    select: { id: true, workId: true }
  });
  if (!edition) return fail('读物版本不存在或无权访问', 404);
  const extra = typeof body.extra === 'object' && body.extra ? body.extra as Record<string, unknown> : {};
  const volumeId = typeof extra.volumeId === 'string' ? extra.volumeId : typeof extra.sectionId === 'string' ? extra.sectionId : null;
  const progress = await prisma.libraryReadingProgress.upsert({
    where: { userId_editionId: { userId: user.id, editionId: params.id } },
    create: {
      userId: user.id,
      workId: edition.workId,
      editionId: params.id,
      volumeId,
      readerType: body.readerType ?? 'unknown',
      position: body.position ?? '0',
      page: body.page ?? null,
      percent: body.percent ?? 0,
      extra: safeExtra(body.extra)
    },
    update: {
      volumeId,
      readerType: body.readerType ?? 'unknown',
      position: body.position ?? '0',
      page: body.page ?? null,
      percent: body.percent ?? 0,
      extra: safeExtra(body.extra)
    }
  });
  await prisma.libraryWork.update({
    where: { id: edition.workId },
    data: { status: progress.percent >= 99 ? 'FINISHED' : 'READING' }
  });
  return ok({ progress });
}

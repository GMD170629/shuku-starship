import { requireUser } from '../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const progress = await prisma.readingProgress.findUnique({
    where: { userId_bookId: { userId: user.id, bookId: params.id } }
  });
  return ok({ progress });
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const body = await readJson<{ readerType?: string; position?: string; page?: number; percent?: number; extra?: unknown }>(request);
  const book = await prisma.book.findFirst({ where: { id: params.id, hidden: false }, select: { id: true } });
  if (!book) return fail('读物不存在或无权访问', 404);
  const progress = await prisma.readingProgress.upsert({
    where: { userId_bookId: { userId: user.id, bookId: params.id } },
    create: {
      userId: user.id,
      bookId: params.id,
      readerType: body.readerType ?? 'unknown',
      position: body.position ?? '0',
      page: body.page,
      percent: Math.max(0, Math.min(100, body.percent ?? 0)),
      extra: JSON.stringify(body.extra ?? {})
    },
    update: {
      readerType: body.readerType ?? 'unknown',
      position: body.position ?? '0',
      page: body.page,
      percent: Math.max(0, Math.min(100, body.percent ?? 0)),
      extra: JSON.stringify(body.extra ?? {})
    }
  });
  await prisma.book.update({
    where: { id: params.id },
    data: { status: progress.percent >= 99 ? 'FINISHED' : 'READING' }
  });
  return ok({ progress });
}

export async function POST(request: Request, context: { params: { id: string } }) {
  return PUT(request, context);
}

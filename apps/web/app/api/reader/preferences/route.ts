import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

const readerTypes = new Set(['epub', 'txt', 'comic']);

function safeParse(value: string | null | undefined) {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const readerType = url.searchParams.get('readerType') ?? 'epub';
  if (!readerTypes.has(readerType)) return fail('阅读器类型不正确', 400);
  const preference = await prisma.readerPreference.findUnique({
    where: { userId_readerType: { userId: user.id, readerType } }
  });
  return ok({ readerType, settings: safeParse(preference?.settings) });
}

export async function PUT(request: Request) {
  const user = await requireUser();
  const body = await readJson<{ readerType?: string; settings?: Record<string, unknown> }>(request);
  const readerType = body.readerType ?? 'epub';
  if (!readerTypes.has(readerType)) return fail('阅读器类型不正确', 400);
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
  await prisma.readerPreference.upsert({
    where: { userId_readerType: { userId: user.id, readerType } },
    create: { userId: user.id, readerType, settings: JSON.stringify(settings) },
    update: { settings: JSON.stringify(settings) }
  });
  return ok({ readerType, settings });
}

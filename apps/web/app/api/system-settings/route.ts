import { requireUser } from '../../../lib/auth';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

const allowedKeys = new Set(['systemName', 'theme', 'language', 'timezone']);

export async function GET() {
  await requireUser();
  const settings = await prisma.systemSetting.findMany();
  return ok({ settings: Object.fromEntries(settings.map((item) => [item.key, item.value])) });
}

export async function PUT(request: Request) {
  await requireUser();
  const body = await readJson<Record<string, string>>(request);
  const entries = Object.entries(body).filter(([key]) => allowedKeys.has(key));
  if (entries.length === 0) return fail('没有可保存的设置', 400);
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) }
      })
    )
  );
  return ok({ saved: true });
}

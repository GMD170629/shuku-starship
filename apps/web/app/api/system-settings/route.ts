import { requireUser } from '../../../lib/auth';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

const secretKeys = new Set(['metadata.douban.apiKey', 'metadata.bangumi.accessToken', 'metadata.ai.apiKey']);
const allowedKeys = new Set([
  'systemName',
  'theme',
  'language',
  'timezone',
  'metadata.external.enabled',
  'metadata.douban.enabled',
  'metadata.douban.baseUrl',
  'metadata.douban.apiKey',
  'metadata.bangumi.enabled',
  'metadata.bangumi.accessToken',
  'metadata.bangumi.userAgent',
  'metadata.ai.enabled',
  'metadata.ai.baseUrl',
  'metadata.ai.apiKey',
  'metadata.ai.model'
]);

function publicValue(key: string, value: string) {
  if (!secretKeys.has(key)) return value;
  return value ? '********' : '';
}

export async function GET() {
  await requireUser();
  const settings = await prisma.systemSetting.findMany();
  return ok({ settings: Object.fromEntries(settings.map((item) => [item.key, publicValue(item.key, item.value)])) });
}

export async function PUT(request: Request) {
  await requireUser();
  const body = await readJson<Record<string, string>>(request);
  const entries = Object.entries(body).filter(([key, value]) => allowedKeys.has(key) && !(secretKeys.has(key) && String(value) === '********'));
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

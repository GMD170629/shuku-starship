import { requireUser } from '../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { getSourceProvider } from '../../../../../lib/sources/provider-registry';
import { searchResultToRecordData, toSourceSearchRecordView } from '../../../../../lib/sources/search-records';
import type { SourceSearchQuery } from '../../../../../lib/sources/source-provider';

function parsePositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function parseKind(value: unknown): SourceSearchQuery['kind'] {
  return value === 'novel' || value === 'comic' || value === 'mixed' ? value : undefined;
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<{ keyword?: string; kind?: string; page?: number; pageSize?: number; saveResults?: boolean }>(request);
  const keyword = body.keyword?.trim();
  if (!keyword) return fail('请输入搜索关键词', 400);
  const source = await prisma.source.findUnique({ where: { id: params.id } });
  if (!source) return fail('源不存在', 404);
  if (!source.enabled) return fail('源已禁用，请启用后再搜索', 400);
  let provider;
  let results;
  try {
    provider = getSourceProvider(source.providerType);
    results = await provider.search(source, {
      keyword,
      kind: parseKind(body.kind),
      page: parsePositiveInt(body.page, 1, 9999),
      pageSize: parsePositiveInt(body.pageSize, 20, 100)
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : '搜索失败', 400);
  }
  const records = body.saveResults
    ? await Promise.all(results.map((result) => {
        const data = searchResultToRecordData(source, result);
        return prisma.sourceSearchRecord.upsert({
          where: { sourceId_externalId: { sourceId: source.id, externalId: data.externalId } },
          create: { ...data, status: 'saved' },
          update: { ...data, status: 'saved' },
          include: { source: { select: { name: true } } }
        });
      }))
    : [];
  return ok({
    results,
    records: records.map(toSourceSearchRecordView),
    provider: { providerType: provider.providerType, capabilities: provider.capabilities }
  });
}

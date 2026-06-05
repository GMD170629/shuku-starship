import { Prisma } from '@prisma/client';
import { requireUser } from '../../../lib/auth';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';
import { parseSourceSearchRecordStatus, searchResultToRecordData, toSourceSearchRecordView } from '../../../lib/sources/search-records';
import type { SourceSearchResult } from '../../../lib/sources/source-provider';

type RecordBody = Partial<SourceSearchResult> & {
  sourceId?: string;
  status?: string;
};

function parseDate(value: unknown) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function jsonInput(value: unknown) {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

export async function GET(request: Request) {
  await requireUser();
  const url = new URL(request.url);
  const sourceId = url.searchParams.get('sourceId')?.trim();
  const status = url.searchParams.get('status')?.trim();
  const providerType = url.searchParams.get('providerType')?.trim();
  const keyword = url.searchParams.get('keyword')?.trim();
  const where: Prisma.SourceSearchRecordWhereInput = {};
  if (sourceId && sourceId !== 'all') where.sourceId = sourceId;
  if (status && status !== 'all') where.status = status;
  if (providerType && providerType !== 'all') where.providerType = providerType;
  if (keyword) {
    where.OR = [
      { title: { contains: keyword } },
      { subtitle: { contains: keyword } },
      { author: { contains: keyword } }
    ];
  }
  const records = await prisma.sourceSearchRecord.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: { source: { select: { name: true } } }
  });
  return ok({ records: records.map(toSourceSearchRecordView) });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<RecordBody>(request);
  if (!body.sourceId) return fail('缺少 sourceId', 400);
  if (!body.externalId?.trim()) return fail('缺少 externalId', 400);
  if (!body.title?.trim()) return fail('缺少标题', 400);
  const source = await prisma.source.findUnique({ where: { id: body.sourceId } });
  if (!source) return fail('源不存在', 404);
  const baseData = searchResultToRecordData(source, {
    sourceId: source.id,
    providerType: body.providerType ?? source.providerType,
    externalId: body.externalId,
    title: body.title,
    subtitle: body.subtitle,
    author: body.author,
    description: body.description,
    coverUrl: body.coverUrl,
    externalUrl: body.externalUrl,
    format: body.format,
    size: body.size,
    language: body.language,
    publishedAt: body.publishedAt,
    downloadAvailable: Boolean(body.downloadAvailable),
    downloadMeta: body.downloadMeta,
    raw: body.raw
  });
  const status = body.status ? parseSourceSearchRecordStatus(body.status) : null;
  if (body.status && !status) return fail('状态不正确', 400);
  const record = await prisma.sourceSearchRecord.upsert({
    where: { sourceId_externalId: { sourceId: source.id, externalId: baseData.externalId } },
    create: { ...baseData, status: status ?? 'saved' },
    update: { ...baseData, ...(status ? { status } : {}) },
    include: { source: { select: { name: true } } }
  });
  return ok({ record: toSourceSearchRecordView(record) }, { status: 201 });
}

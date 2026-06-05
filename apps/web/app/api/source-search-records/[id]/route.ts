import { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';
import { parseSourceSearchRecordStatus, toSourceSearchRecordView } from '../../../../lib/sources/search-records';

type RecordUpdateBody = {
  status?: string;
  title?: string;
  subtitle?: string | null;
  author?: string | null;
  description?: string | null;
  externalUrl?: string | null;
  format?: string | null;
  size?: string | null;
  language?: string | null;
};

function nullableString(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.trim() || null;
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<RecordUpdateBody>(request);
  const data: Prisma.SourceSearchRecordUpdateInput = {};
  if (body.status !== undefined) {
    const status = parseSourceSearchRecordStatus(body.status);
    if (!status) return fail('状态不正确', 400);
    data.status = status;
  }
  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return fail('标题不能为空', 400);
    data.title = title;
  }
  for (const key of ['subtitle', 'author', 'description', 'externalUrl', 'format', 'size', 'language'] as const) {
    if (body[key] !== undefined) data[key] = nullableString(body[key]);
  }
  const record = await prisma.sourceSearchRecord.update({
    where: { id: params.id },
    data,
    include: { source: { select: { name: true } } }
  }).catch(() => null);
  if (!record) return fail('搜索结果不存在', 404);
  return ok({ record: toSourceSearchRecordView(record) });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const result = await prisma.sourceSearchRecord.deleteMany({ where: { id: params.id } });
  if (result.count === 0) return fail('搜索结果不存在', 404);
  return ok({ deleted: true });
}

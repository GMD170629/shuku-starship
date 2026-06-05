import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { toSourceSearchRecordView } from '../../../../../lib/sources/search-records';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const record = await prisma.sourceSearchRecord.update({
    where: { id: params.id },
    data: { status: 'saved' },
    include: { source: { select: { name: true } } }
  }).catch(() => null);
  if (!record) return fail('搜索结果不存在', 404);
  return ok({ record: toSourceSearchRecordView(record) });
}

import { searchMetadataCandidates, type MetadataLookupSource } from '@shuku/scanner/organize-pipeline';
import { requireUser } from '../../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';

type SearchBody = {
  source?: string;
  query?: string;
};

function parseSource(value: unknown): MetadataLookupSource | null {
  return value === 'bangumi' || value === 'douban' || value === 'ai' ? value : null;
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<SearchBody>(request);
  const source = parseSource(body.source);
  if (!source) return fail('请选择元数据来源', 400);
  const query = String(body.query ?? '').trim();
  if (!query) return fail('请输入查询文本', 400);
  const work = await prisma.libraryWork.findUnique({ where: { id: params.id }, select: { id: true, hidden: true } });
  if (!work || work.hidden) return fail('读物不存在或无权访问', 404);
  try {
    const candidates = await searchMetadataCandidates({ workId: params.id, source, query });
    return ok({ candidates });
  } catch (error) {
    return fail(error instanceof Error ? error.message : '元数据查询失败', 400);
  }
}

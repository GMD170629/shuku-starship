import { applyMetadataCandidate, type MetadataApplyField, type MetadataCandidate, type MetadataLookupSource } from '@shuku/scanner/organize-pipeline';
import { requireUser } from '../../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../../lib/http';
import { toWorkView } from '../../../../../../lib/books';
import { prisma } from '../../../../../../lib/prisma';

type ApplyBody = {
  source?: string;
  candidate?: MetadataCandidate;
  fields?: string[];
};

const metadataApplyFields = new Set<MetadataApplyField>(['title', 'author', 'description', 'tags', 'seriesName', 'seriesIndex', 'publishedYear', 'publisher', 'coverUrl']);

function parseSource(value: unknown): MetadataLookupSource | null {
  return value === 'bangumi' || value === 'douban' || value === 'ai' ? value : null;
}

function parseFields(value: unknown): MetadataApplyField[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((field): field is MetadataApplyField => metadataApplyFields.has(field as MetadataApplyField)))];
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const body = await readJson<ApplyBody>(request);
  const source = parseSource(body.source);
  if (!source) return fail('请选择元数据来源', 400);
  if (!body.candidate || typeof body.candidate !== 'object') return fail('请选择要应用的候选', 400);
  const fields = parseFields(body.fields);
  if (fields.length === 0) return fail('请选择要应用的字段', 400);
  const work = await prisma.libraryWork.findUnique({ where: { id: params.id }, select: { id: true, hidden: true } });
  if (!work || work.hidden) return fail('读物不存在或无权访问', 404);
  try {
    const result = await applyMetadataCandidate({ workId: params.id, source, candidate: body.candidate, fields });
    const updated = await prisma.libraryWork.findUnique({
      where: { id: params.id },
      include: {
        editions: {
          where: { hidden: false },
          orderBy: [{ primary: 'desc' }, { createdAt: 'asc' }],
          include: {
            files: { orderBy: { sortOrder: 'asc' } },
            volumes: { orderBy: { sortOrder: 'asc' } },
            progresses: { where: { userId: user.id }, take: 1 }
          }
        },
        progresses: { where: { userId: user.id }, take: 1 }
      }
    });
    return ok({ ...result, book: updated ? toWorkView(updated) : null });
  } catch (error) {
    return fail(error instanceof Error ? error.message : '元数据应用失败', 400);
  }
}

import { applyMetadataSuggestions } from '@shuku/scanner/organize-pipeline';
import { requireUser } from '../../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';

type ApplyBody = {
  suggestionIds?: string[];
  duplicateIds?: string[];
  highConfidenceOnly?: boolean;
  markOrganized?: boolean;
  dismiss?: boolean;
};

export async function POST(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<ApplyBody>(request);
  const job = await prisma.organizeJob.findUnique({ where: { id: params.id }, include: { duplicates: true } });
  if (!job) return fail('整理任务不存在', 404);
  const result = await applyMetadataSuggestions({
    jobId: params.id,
    suggestionIds: body.suggestionIds,
    highConfidenceOnly: body.highConfidenceOnly,
    markOrganized: body.markOrganized,
    dismiss: body.dismiss
  });

  const duplicateIds = [...new Set((body.duplicateIds ?? []).map(String).filter(Boolean))];
  if (duplicateIds.length) {
    await prisma.duplicateCandidate.updateMany({ where: { id: { in: duplicateIds }, jobId: params.id }, data: { status: 'APPLIED' } });
  }
  if (body.markOrganized) {
    await prisma.metadataSuggestion.updateMany({ where: { jobId: params.id, status: 'PENDING' }, data: { status: 'DISMISSED' } });
    await prisma.duplicateCandidate.updateMany({ where: { jobId: params.id, status: 'PENDING' }, data: { status: 'DISMISSED' } });
  }
  return ok({ ...result, duplicateActionsApplied: duplicateIds.length });
}

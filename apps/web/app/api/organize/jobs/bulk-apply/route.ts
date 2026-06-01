import { applyMetadataSuggestions } from '@shuku/scanner/organize-pipeline';
import { requireUser } from '../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../lib/http';
import { mergeTags } from '../../../../../lib/book-metadata';
import { parseTags } from '../../../../../lib/books';
import { prisma } from '../../../../../lib/prisma';

type BulkApplyBody = {
  jobIds?: string[];
  highConfidenceOnly?: boolean;
  markOrganized?: boolean;
  addTags?: string[];
};

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<BulkApplyBody>(request);
  const jobIds = [...new Set((body.jobIds ?? []).map(String).filter(Boolean))];
  if (jobIds.length === 0) return fail('请选择要批量处理的整理任务', 400);
  if (jobIds.length > 200) return fail('单次最多批量处理 200 个整理任务', 400);
  const jobs = await prisma.organizeJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, workId: true } });
  let applied = 0;
  for (const job of jobs) {
    const result = await applyMetadataSuggestions({
      jobId: job.id,
      highConfidenceOnly: body.highConfidenceOnly ?? true,
      markOrganized: body.markOrganized
    });
    applied += result.applied;
  }
  const tags = [...new Set((body.addTags ?? []).map(String).map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length) {
    const works = await prisma.libraryWork.findMany({ where: { id: { in: jobs.map((job) => job.workId) } }, select: { id: true, tags: true } });
    await prisma.$transaction(
      works.map((work) =>
        prisma.libraryWork.update({
          where: { id: work.id },
          data: { tags: JSON.stringify(mergeTags(parseTags(work.tags), tags, [])) }
        })
      )
    );
  }
  return ok({ matched: jobIds.length, jobs: jobs.length, applied, tagsAdded: tags.length });
}

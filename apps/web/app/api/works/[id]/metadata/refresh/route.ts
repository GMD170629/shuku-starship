import { createOrRefreshOrganizeJob, refreshOrganizeMetadataProviders, type RefreshProvider } from '@shuku/scanner/organize-pipeline';
import { requireUser } from '../../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';

type RefreshBody = {
  providers?: string[];
};

function refreshProviders(value: unknown): RefreshProvider[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((provider): provider is RefreshProvider => provider === 'external' || provider === 'ai'))];
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<RefreshBody>(request);
  const providers = refreshProviders(body.providers);
  if (providers.length === 0) return fail('请选择要刷新的元数据来源', 400);

  const work = await prisma.libraryWork.findUnique({
    where: { id: params.id },
    select: { id: true, primaryEditionId: true, hidden: true }
  });
  if (!work || work.hidden) return fail('读物不存在或无权访问', 404);

  const existingJob = await prisma.organizeJob.findFirst({
    where: { workId: work.id, status: { in: ['PENDING', 'REVIEWING'] } },
    orderBy: { updatedAt: 'desc' },
    select: { id: true }
  });
  const job = existingJob ?? await createOrRefreshOrganizeJob({ workId: work.id, editionId: work.primaryEditionId });
  if (!job) return fail('整理任务创建失败', 500);

  const result = await refreshOrganizeMetadataProviders(job.id, providers, { force: true });
  const disabled = result.results.every((item) => !item.enabled);
  const errors = result.results.filter((item) => item.error);
  const usable = result.results.some((item) => item.enabled && !item.error);
  const disabledMessages = result.results.map((item) => item.message).filter(Boolean);
  return ok({
    jobId: job.id,
    ...result,
    enabled: usable,
    message: disabled
      ? disabledMessages.join('；') || '外部数据查询或 AI 识别尚未配置。'
      : !usable && errors.length
        ? `元数据刷新失败：${errors.map((item) => item.error).join('；')}`
        : `已刷新，新增 ${result.added} 条候选建议。`
  });
}

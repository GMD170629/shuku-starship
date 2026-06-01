import { refreshOrganizeMetadataProviders } from '@shuku/scanner/organize-pipeline';
import { requireUser } from '../../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';

type RefreshBody = {
  providers?: string[];
};

export async function POST(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<RefreshBody>(request);
  const job = await prisma.organizeJob.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!job) return fail('整理任务不存在', 404);
  const providers = [...new Set((body.providers ?? []).map(String).filter((provider): provider is 'external' | 'ai' => provider === 'external' || provider === 'ai'))];
  if (providers.length === 0) return fail('请选择要刷新的元数据来源', 400);
  const result = await refreshOrganizeMetadataProviders(params.id, providers);
  const disabled = result.results.every((item) => !item.enabled);
  return ok({
    ...result,
    enabled: !disabled,
    message: disabled ? '外部数据查询或 AI 识别尚未启用。' : `已刷新，新增 ${result.added} 条候选建议。`
  });
}

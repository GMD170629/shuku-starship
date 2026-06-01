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
  const providers = [...new Set((body.providers ?? []).map(String).filter((provider) => provider === 'external' || provider === 'ai'))];
  return ok({
    enabled: false,
    providers,
    message: '外部数据查询和 AI 识别接口已预留，当前尚未启用数据源。'
  });
}

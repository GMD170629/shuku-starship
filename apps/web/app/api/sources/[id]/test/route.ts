import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';
import { isSourceKind, isSourceProviderType, toSourceView } from '../../../../../lib/sources';
import { getSourceProvider } from '../../../../../lib/sources/provider-registry';

function basicConfigStatus(source: { name: string; kind: string; providerType: string }) {
  if (!source.name.trim()) return { status: 'failed', message: '源名称为空' };
  if (!isSourceKind(source.kind)) return { status: 'failed', message: '内容类型不正确' };
  if (!isSourceProviderType(source.providerType)) return { status: 'failed', message: '源类型不正确' };
  return { status: 'ok', message: '基础配置有效，连接测试占位已通过' };
}

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const source = await prisma.source.findUnique({ where: { id: params.id } });
  if (!source) return fail('源不存在', 404);
  const basic = basicConfigStatus(source);
  let providerResult = null;
  if (basic.status === 'ok') {
    try {
      const provider = getSourceProvider(source.providerType);
      providerResult = provider.test ? await provider.test(source) : { ok: true, message: 'Provider 已注册，但未提供测试方法。' };
    } catch (error) {
      providerResult = { ok: false, message: error instanceof Error ? error.message : 'Provider 未实现。' };
    }
  }
  const result = providerResult
    ? { status: providerResult.ok ? 'ok' : 'failed', message: providerResult.message, details: providerResult.details }
    : basic;
  const updated = await prisma.source.update({
    where: { id: source.id },
    data: {
      lastTestAt: new Date(),
      lastTestStatus: result.status,
      lastError: result.status === 'ok' ? null : result.message
    }
  });
  return ok({ result, source: toSourceView(updated) });
}

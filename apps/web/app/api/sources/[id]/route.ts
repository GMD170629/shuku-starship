import { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';
import { isSourceKind, isSourceProviderType, toSourceView } from '../../../../lib/sources';

type SourceBody = {
  name?: string;
  kind?: string;
  providerType?: string;
  enabled?: boolean;
  priority?: number | string;
  config?: unknown;
  credentialsKey?: string | null;
  capabilities?: unknown;
  rateLimit?: unknown;
};

function parsePriority(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 9999) return null;
  return parsed;
}

function isMaskedSecret(value: unknown) {
  return Boolean(value && typeof value === 'object' && (value as { configured?: unknown }).configured === true && 'masked' in value);
}

function preserveMaskedSecrets(next: unknown, current: unknown): unknown {
  if (isMaskedSecret(next)) return current;
  if (Array.isArray(next)) {
    const currentItems = Array.isArray(current) ? current : [];
    return next.map((item, index) => preserveMaskedSecrets(item, currentItems[index]));
  }
  if (next && typeof next === 'object') {
    const output: Record<string, unknown> = {};
    const currentObject = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
      output[key] = preserveMaskedSecrets(value, currentObject[key]);
    }
    return output;
  }
  return next;
}

function jsonUpdate(value: unknown, current: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return preserveMaskedSecrets(value, current) as Prisma.InputJsonValue;
}

async function sourceHasBindings(_sourceId: string) {
  return (await prisma.sourceSearchRecord.count({ where: { sourceId: _sourceId } })) > 0;
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const source = await prisma.source.findUnique({ where: { id: params.id } });
  if (!source) return fail('源不存在', 404);
  return ok({ source: toSourceView(source) });
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const current = await prisma.source.findUnique({ where: { id: params.id } });
  if (!current) return fail('源不存在', 404);
  const body = await readJson<SourceBody>(request);
  const data: Prisma.SourceUpdateInput = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return fail('请输入源名称', 400);
    data.name = name;
  }
  if (body.kind !== undefined) {
    if (!isSourceKind(body.kind)) return fail('内容类型不正确', 400);
    data.kind = body.kind;
  }
  if (body.providerType !== undefined) {
    if (!isSourceProviderType(body.providerType)) return fail('源类型不正确', 400);
    data.providerType = body.providerType;
  }
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
  if (body.priority !== undefined) {
    const priority = parsePriority(body.priority);
    if (priority === null) return fail('优先级必须是 0-9999 的整数', 400);
    if (priority !== undefined) data.priority = priority;
  }
  const config = jsonUpdate(body.config, current.config);
  const capabilities = jsonUpdate(body.capabilities, current.capabilities);
  const rateLimit = jsonUpdate(body.rateLimit, current.rateLimit);
  if (config !== undefined) data.config = config;
  if (capabilities !== undefined) data.capabilities = capabilities;
  if (rateLimit !== undefined) data.rateLimit = rateLimit;
  if (body.credentialsKey !== undefined) data.credentialsKey = typeof body.credentialsKey === 'string' ? body.credentialsKey.trim() || null : null;
  const source = await prisma.source.update({ where: { id: params.id }, data });
  return ok({ source: toSourceView(source) });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const source = await prisma.source.findUnique({ where: { id: params.id } });
  if (!source) return fail('源不存在', 404);
  if (await sourceHasBindings(source.id)) {
    const disabled = await prisma.source.update({ where: { id: source.id }, data: { enabled: false } });
    return ok({ source: toSourceView(disabled), deleted: false, disabled: true });
  }
  await prisma.source.delete({ where: { id: source.id } });
  return ok({ deleted: true });
}

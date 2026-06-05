import { Prisma } from '@prisma/client';
import { requireUser } from '../../../lib/auth';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';
import { isSourceKind, isSourceProviderType, toSourceView } from '../../../lib/sources';

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
  if (value === undefined || value === null || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 9999) return null;
  return parsed;
}

function jsonInput(value: unknown) {
  if (value === undefined) return undefined;
  return value === null ? Prisma.DbNull : value as Prisma.InputJsonValue;
}

function sourceDataFromBody(body: SourceBody): Prisma.SourceCreateInput | { error: string } {
  const name = body.name?.trim();
  if (!name) return { error: '请输入源名称' };
  if (!isSourceKind(body.kind)) return { error: '内容类型不正确' };
  if (!isSourceProviderType(body.providerType)) return { error: '源类型不正确' };
  const priority = parsePriority(body.priority);
  if (priority === null) return { error: '优先级必须是 0-9999 的整数' };
  return {
    name,
    kind: body.kind,
    providerType: body.providerType,
    enabled: body.enabled ?? true,
    priority,
    config: jsonInput(body.config),
    credentialsKey: typeof body.credentialsKey === 'string' ? body.credentialsKey.trim() || null : null,
    capabilities: jsonInput(body.capabilities),
    rateLimit: jsonInput(body.rateLimit)
  };
}

export async function GET() {
  await requireUser();
  const sources = await prisma.source.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }] });
  return ok({ sources: sources.map(toSourceView) });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<SourceBody>(request);
  const data = sourceDataFromBody(body);
  if ('error' in data) return fail(data.error, 400);
  const source = await prisma.source.create({ data });
  return ok({ source: toSourceView(source) }, { status: 201 });
}

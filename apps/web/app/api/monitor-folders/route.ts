import { PathSecurityError, PathSecurityService } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../lib/auth';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

function securityStatus(error: PathSecurityError) {
  return error.code === 'PATH_UNAVAILABLE' || error.code === 'MONITOR_ROOT_UNAVAILABLE' ? 404 : 400;
}

function parseMinFileSizeBytes(value: unknown, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

export async function GET() {
  await requireUser();
  const folders = await prisma.monitorFolder.findMany({ orderBy: { createdAt: 'desc' } });
  return ok({ folders, monitorRoot: PathSecurityService.configuredMonitorRoot() });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ name?: string; rootPath?: string; enabled?: boolean; ignorePatterns?: string; ignoreHidden?: boolean; minFileSizeBytes?: number; description?: string }>(request);
  const rootPath = body.rootPath?.trim();
  if (!rootPath) return fail('请输入监控文件夹路径', 400);
  const minFileSizeBytes = parseMinFileSizeBytes(body.minFileSizeBytes);
  if (minFileSizeBytes === null) return fail('最小文件大小必须是大于等于 0 的数字', 400);
  let validation;
  try {
    validation = await PathSecurityService.fromEnv().validateMonitorFolder(rootPath);
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, securityStatus(error));
    throw error;
  }
  const folder = await prisma.monitorFolder.create({
    data: {
      name: body.name?.trim() || validation.realPath.split('/').filter(Boolean).at(-1) || '监控文件夹',
      rootPath: validation.realPath,
      enabled: body.enabled ?? true,
      ignorePatterns: body.ignorePatterns ?? '',
      ignoreHidden: body.ignoreHidden ?? true,
      minFileSizeBytes,
      description: body.description
    }
  });
  return ok({ folder }, { status: 201 });
}

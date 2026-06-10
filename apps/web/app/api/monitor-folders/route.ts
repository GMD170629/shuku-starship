import { Prisma } from '@prisma/client';
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

function parseImportMode(value: unknown, fallback: 'COPY' | 'MOVE' = 'COPY') {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'COPY' || value === 'MOVE' ? value : null;
}

export async function GET() {
  await requireUser();
  const folders = await prisma.monitorFolder.findMany({ orderBy: { createdAt: 'desc' } });
  return ok({ folders, monitorRoot: PathSecurityService.configuredMonitorRoot() });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ name?: string; rootPath?: string; enabled?: boolean; importMode?: string; ignorePatterns?: string; ignoreHidden?: boolean; minFileSizeBytes?: number; description?: string }>(request);
  const rootPath = body.rootPath?.trim();
  if (!rootPath) return fail('请输入监控文件夹路径', 400);
  const minFileSizeBytes = parseMinFileSizeBytes(body.minFileSizeBytes);
  if (minFileSizeBytes === null) return fail('最小文件大小必须是大于等于 0 的数字', 400);
  const importMode = parseImportMode(body.importMode);
  if (importMode === null) return fail('添加模式必须是 COPY 或 MOVE', 400);
  let validation;
  try {
    validation = await PathSecurityService.fromEnv().validateMonitorFolder(rootPath);
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, securityStatus(error));
    throw error;
  }
  const name = body.name?.trim() || validation.realPath.split('/').filter(Boolean).at(-1) || '监控文件夹';
  const data = {
    name,
    enabled: body.enabled ?? true,
    importMode,
    ignorePatterns: body.ignorePatterns ?? '',
    ignoreHidden: body.ignoreHidden ?? true,
    minFileSizeBytes,
    description: body.description
  };
  try {
    const existing = await prisma.monitorFolder.findUnique({ where: { rootPath: validation.realPath }, select: { id: true } });
    const folder = await prisma.monitorFolder.upsert({
      where: { rootPath: validation.realPath },
      create: {
        ...data,
        rootPath: validation.realPath
      },
      update: data
    });
    return ok({ folder, updatedExisting: Boolean(existing) }, { status: existing ? 200 : 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return fail('该监控文件夹路径已存在，请在已有配置中修改。', 409);
    }
    throw error;
  }
}

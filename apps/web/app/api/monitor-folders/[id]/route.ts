import { PathSecurityError, PathSecurityService } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

function securityStatus(error: PathSecurityError) {
  return error.code === 'PATH_UNAVAILABLE' || error.code === 'MONITOR_ROOT_UNAVAILABLE' ? 404 : 400;
}

function parseMinFileSizeBytes(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<{ name?: string; rootPath?: string; enabled?: boolean; ignorePatterns?: string; ignoreHidden?: boolean; minFileSizeBytes?: number; description?: string }>(request);
  const data: Record<string, unknown> = {};
  if (typeof body.name === 'string') data.name = body.name.trim();
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
  if (typeof body.ignorePatterns === 'string') data.ignorePatterns = body.ignorePatterns;
  if (typeof body.ignoreHidden === 'boolean') data.ignoreHidden = body.ignoreHidden;
  if (body.minFileSizeBytes !== undefined) {
    const minFileSizeBytes = parseMinFileSizeBytes(body.minFileSizeBytes);
    if (minFileSizeBytes === null) return fail('最小文件大小必须是大于等于 0 的数字', 400);
    data.minFileSizeBytes = minFileSizeBytes;
  }
  if (typeof body.description === 'string') data.description = body.description;
  if (typeof body.rootPath === 'string') {
    const rootPath = body.rootPath.trim();
    try {
      data.rootPath = (await PathSecurityService.fromEnv().validateMonitorFolder(rootPath)).realPath;
    } catch (error) {
      if (error instanceof PathSecurityError) return fail(error.message, securityStatus(error));
      throw error;
    }
  }
  const folder = await prisma.monitorFolder.update({ where: { id: params.id }, data });
  return ok({ folder });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  await prisma.monitorFolder.delete({ where: { id: params.id } });
  return ok({ deleted: true });
}

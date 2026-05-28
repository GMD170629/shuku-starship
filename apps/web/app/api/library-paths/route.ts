import { PathSecurityError, PathSecurityService } from '@shuku/scanner/path-security-service';
import { requireUser } from '../../../lib/auth';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

function securityStatus(error: PathSecurityError) {
  return error.code === 'PATH_UNAVAILABLE' || error.code === 'BOOKS_ROOT_UNAVAILABLE' ? 404 : 400;
}

function parseMinFileSizeBytes(value: unknown, fallback = 10240) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

export async function GET() {
  await requireUser();
  const paths = await prisma.libraryPath.findMany({ orderBy: { createdAt: 'desc' } });
  return ok({ paths });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ name?: string; rootPath?: string; enabled?: boolean; scanPolicy?: string; ignorePatterns?: string; ignoreHidden?: boolean; minFileSizeBytes?: number; description?: string }>(request);
  const rootPath = body.rootPath?.trim();
  if (!rootPath) return fail('请输入书库根路径', 400);
  const minFileSizeBytes = parseMinFileSizeBytes(body.minFileSizeBytes);
  if (minFileSizeBytes === null) return fail('最小文件大小必须是大于等于 0 的数字', 400);
  let validation;
  try {
    validation = await PathSecurityService.fromEnv().validateLibraryRoot(rootPath);
  } catch (error) {
    if (error instanceof PathSecurityError) return fail(error.message, securityStatus(error));
    throw error;
  }
  const path = await prisma.libraryPath.create({
    data: {
      name: body.name?.trim() || validation.realPath.split('/').filter(Boolean).at(-1) || '书库目录',
      rootPath: validation.realPath,
      enabled: body.enabled ?? true,
      scanPolicy: body.scanPolicy ?? 'manual',
      ignorePatterns: body.ignorePatterns ?? '',
      ignoreHidden: body.ignoreHidden ?? true,
      minFileSizeBytes,
      description: body.description
    }
  });
  return ok({ path }, { status: 201 });
}

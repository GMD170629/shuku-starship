import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type PathSecurityErrorCode =
  | 'EMPTY_PATH'
  | 'NOT_ABSOLUTE'
  | 'BOOKS_ROOT_UNAVAILABLE'
  | 'PATH_UNAVAILABLE'
  | 'SENSITIVE_PATH'
  | 'OUTSIDE_BOOKS_ROOT'
  | 'NOT_DIRECTORY'
  | 'NOT_FILE';

export class PathSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: PathSecurityErrorCode
  ) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

export type PathSecurityValidation = {
  inputPath: string;
  realPath: string;
  booksRoot: string;
  realBooksRoot: string;
};

const sensitivePaths = ['/', '/etc', '/root', '/proc', '/sys', '/dev', '/var', '/var/run', '/run', '/boot'];

function isInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function isSensitivePath(path: string) {
  const normalized = resolve(path);
  return sensitivePaths.some((sensitivePath) => normalized === sensitivePath || normalized.startsWith(`${sensitivePath}/`));
}

function findWorkspaceRoot(start: string) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function normalizeConfiguredPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed || isAbsolute(trimmed)) return trimmed;
  const base =
    process.env.SHUKU_ROOT ||
    findWorkspaceRoot(process.cwd()) ||
    (process.env.INIT_CWD ? findWorkspaceRoot(process.env.INIT_CWD) : null) ||
    process.env.INIT_CWD ||
    process.cwd();
  return resolve(base, trimmed);
}

export function configuredScanQueueName() {
  const explicit = process.env.SCAN_QUEUE_NAME?.trim();
  if (explicit) return explicit;

  const booksRoot = process.env.BOOKS_ROOT ? normalizeConfiguredPath(process.env.BOOKS_ROOT) : 'default';
  const scope = createHash('sha1').update(booksRoot).digest('hex').slice(0, 10);
  return `scan-jobs-${scope}`;
}

async function realpathOrSecurityError(path: string, message: string, code: PathSecurityErrorCode) {
  try {
    return await realpath(path);
  } catch {
    throw new PathSecurityError(message, code);
  }
}

export class PathSecurityService {
  private readonly booksRoot: string;

  constructor(booksRoot = process.env.BOOKS_ROOT || '/books') {
    this.booksRoot = normalizeConfiguredPath(booksRoot);
  }

  static fromEnv() {
    return new PathSecurityService();
  }

  static configuredBooksRoot() {
    return normalizeConfiguredPath(process.env.BOOKS_ROOT || '/books');
  }

  async validateLibraryRoot(inputPath: string): Promise<PathSecurityValidation> {
    const validation = await this.validatePathInsideBooksRoot(inputPath);
    const targetStat = await stat(validation.realPath).catch(() => null);
    if (!targetStat?.isDirectory()) {
      throw new PathSecurityError(`书库路径不是目录：${inputPath}`, 'NOT_DIRECTORY');
    }
    await this.ensureReadable(validation.realPath, `书库路径不存在或不可读：${inputPath}`);
    return validation;
  }

  async validateFileAccess(inputPath: string): Promise<PathSecurityValidation> {
    const validation = await this.validatePathInsideBooksRoot(inputPath);
    const targetStat = await stat(validation.realPath).catch(() => null);
    if (!targetStat?.isFile()) {
      throw new PathSecurityError(`文件不存在或不可读：${inputPath}`, 'NOT_FILE');
    }
    await this.ensureReadable(validation.realPath, `文件不存在或不可读：${inputPath}`);
    return validation;
  }

  private async validatePathInsideBooksRoot(inputPath: string): Promise<PathSecurityValidation> {
    const trimmedPath = inputPath.trim();
    if (!trimmedPath) {
      throw new PathSecurityError('路径不能为空', 'EMPTY_PATH');
    }
    if (!isAbsolute(trimmedPath)) {
      throw new PathSecurityError(`请输入 BOOKS_ROOT 下的绝对路径：${trimmedPath}`, 'NOT_ABSOLUTE');
    }
    if (isSensitivePath(trimmedPath)) {
      throw new PathSecurityError(`禁止访问系统敏感路径：${trimmedPath}`, 'SENSITIVE_PATH');
    }

    const trimmedBooksRoot = this.booksRoot.trim();
    if (!trimmedBooksRoot || !isAbsolute(trimmedBooksRoot)) {
      throw new PathSecurityError(`BOOKS_ROOT 必须是绝对路径：${trimmedBooksRoot || '(empty)'}`, 'BOOKS_ROOT_UNAVAILABLE');
    }

    const realBooksRoot = await realpathOrSecurityError(
      trimmedBooksRoot,
      `BOOKS_ROOT 不存在或不可读：${trimmedBooksRoot}`,
      'BOOKS_ROOT_UNAVAILABLE'
    );
    if (isSensitivePath(realBooksRoot)) {
      throw new PathSecurityError(`BOOKS_ROOT 不能指向系统敏感路径：${realBooksRoot}`, 'BOOKS_ROOT_UNAVAILABLE');
    }

    const realTargetPath = await realpathOrSecurityError(trimmedPath, `路径不存在或不可读：${trimmedPath}`, 'PATH_UNAVAILABLE');
    if (isSensitivePath(realTargetPath)) {
      throw new PathSecurityError(`禁止访问系统敏感路径：${realTargetPath}`, 'SENSITIVE_PATH');
    }
    if (!isInside(realBooksRoot, realTargetPath)) {
      throw new PathSecurityError(`路径真实位置不在 BOOKS_ROOT 内：${trimmedPath} -> ${realTargetPath}`, 'OUTSIDE_BOOKS_ROOT');
    }

    return {
      inputPath: trimmedPath,
      realPath: realTargetPath,
      booksRoot: trimmedBooksRoot,
      realBooksRoot
    };
  }

  private async ensureReadable(path: string, message: string) {
    try {
      await access(path, constants.R_OK);
    } catch {
      throw new PathSecurityError(message, 'PATH_UNAVAILABLE');
    }
  }
}

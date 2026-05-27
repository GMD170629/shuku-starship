import { relative, resolve } from 'node:path';
import { PathSecurityError, PathSecurityService } from '@shuku/scanner/path-security-service';

export function fileSecurityStatus(error: PathSecurityError) {
  return error.code === 'PATH_UNAVAILABLE' || error.code === 'NOT_FILE' || error.code === 'BOOKS_ROOT_UNAVAILABLE' ? 404 : 403;
}

function isInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

export class FileAccessService {
  constructor(private readonly pathSecurity = PathSecurityService.fromEnv()) {}

  async validateReadableFile(filePath: string, libraryRootPath: string) {
    const [fileValidation, libraryValidation] = await Promise.all([
      this.pathSecurity.validateFileAccess(filePath),
      this.pathSecurity.validateLibraryRoot(libraryRootPath)
    ]);
    if (!isInside(libraryValidation.realPath, fileValidation.realPath)) {
      throw new PathSecurityError(`文件真实位置不在所属书库目录内：${fileValidation.realPath}`, 'OUTSIDE_BOOKS_ROOT');
    }
    return fileValidation;
  }
}

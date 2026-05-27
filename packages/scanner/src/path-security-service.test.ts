import { realpath, symlink, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PathSecurityError, PathSecurityService } from './path-security-service';

let tempDir = '';
let previousBooksRoot: string | undefined;

beforeEach(async () => {
  previousBooksRoot = process.env.BOOKS_ROOT;
  tempDir = await mkdtemp(join(process.cwd(), 'path-security-'));
  const booksRoot = join(tempDir, 'books');
  await mkdir(join(booksRoot, 'manga'), { recursive: true });
  process.env.BOOKS_ROOT = booksRoot;
});

afterEach(async () => {
  if (previousBooksRoot === undefined) delete process.env.BOOKS_ROOT;
  else process.env.BOOKS_ROOT = previousBooksRoot;
  await rm(tempDir, { recursive: true, force: true });
});

describe('PathSecurityService', () => {
  it('allows a directory inside BOOKS_ROOT', async () => {
    const booksRoot = process.env.BOOKS_ROOT;
    assert.ok(booksRoot);

    const result = await PathSecurityService.fromEnv().validateLibraryRoot(join(booksRoot, 'manga'));

    assert.equal(result.realPath, await realpath(join(booksRoot, 'manga')));
  });

  it('rejects /etc', async () => {
    await assert.rejects(() => PathSecurityService.fromEnv().validateLibraryRoot('/etc'), (error) => {
      assert.ok(error instanceof PathSecurityError);
      assert.equal(error.code, 'SENSITIVE_PATH');
      assert.match(error.message, /系统敏感路径/);
      return true;
    });
  });

  it('rejects relative path traversal', async () => {
    await assert.rejects(() => PathSecurityService.fromEnv().validateLibraryRoot('../../etc/passwd'), (error) => {
      assert.ok(error instanceof PathSecurityError);
      assert.equal(error.code, 'NOT_ABSOLUTE');
      assert.match(error.message, /绝对路径/);
      return true;
    });
  });

  it('rejects a symlink that resolves outside BOOKS_ROOT', async () => {
    const booksRoot = process.env.BOOKS_ROOT;
    assert.ok(booksRoot);
    const linkPath = join(booksRoot, 'etc-link');
    await symlink('/etc', linkPath);

    await assert.rejects(() => PathSecurityService.fromEnv().validateLibraryRoot(linkPath), (error) => {
      assert.ok(error instanceof PathSecurityError);
      assert.ok(error.code === 'SENSITIVE_PATH' || error.code === 'OUTSIDE_BOOKS_ROOT');
      return true;
    });
  });
});

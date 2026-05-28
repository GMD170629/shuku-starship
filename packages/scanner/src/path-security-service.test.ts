import { realpath, symlink, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { configuredScanQueueName, normalizeConfiguredPath, PathSecurityError, PathSecurityService } from './path-security-service';

let tempDir = '';
let previousBooksRoot: string | undefined;
let previousScanQueueName: string | undefined;

function workspaceRoot() {
  let current = process.cwd();
  while (!existsSync(join(current, 'pnpm-workspace.yaml'))) {
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
  return current;
}

beforeEach(async () => {
  previousBooksRoot = process.env.BOOKS_ROOT;
  previousScanQueueName = process.env.SCAN_QUEUE_NAME;
  tempDir = await mkdtemp(join(process.cwd(), 'path-security-'));
  const booksRoot = join(tempDir, 'books');
  await mkdir(join(booksRoot, 'manga'), { recursive: true });
  process.env.BOOKS_ROOT = booksRoot;
  delete process.env.SCAN_QUEUE_NAME;
});

afterEach(async () => {
  if (previousBooksRoot === undefined) delete process.env.BOOKS_ROOT;
  else process.env.BOOKS_ROOT = previousBooksRoot;
  if (previousScanQueueName === undefined) delete process.env.SCAN_QUEUE_NAME;
  else process.env.SCAN_QUEUE_NAME = previousScanQueueName;
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

  it('resolves relative BOOKS_ROOT from the workspace root when available', () => {
    process.env.BOOKS_ROOT = 'books';
    const normalized = normalizeConfiguredPath(process.env.BOOKS_ROOT);
    assert.equal(normalized, resolve(workspaceRoot(), 'books'));
  });

  it('scopes scan queues by configured BOOKS_ROOT', () => {
    process.env.BOOKS_ROOT = 'books';
    const workspaceQueue = configuredScanQueueName();

    process.env.BOOKS_ROOT = '/books';
    const containerQueue = configuredScanQueueName();

    assert.match(workspaceQueue, /^scan-jobs-[a-f0-9]{10}$/);
    assert.match(containerQueue, /^scan-jobs-[a-f0-9]{10}$/);
    assert.notEqual(workspaceQueue, containerQueue);
  });

  it('allows an explicit scan queue name override', () => {
    process.env.SCAN_QUEUE_NAME = 'scan-jobs-test';
    assert.equal(configuredScanQueueName(), 'scan-jobs-test');
  });
});

import { realpath, symlink, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { normalizeConfiguredPath, PathSecurityError, PathSecurityService } from './path-security-service';

let tempDir = '';
let previousMonitorRoot: string | undefined;

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
  previousMonitorRoot = process.env.MONITOR_ROOT;
  tempDir = await mkdtemp(join(process.cwd(), 'path-security-'));
  const monitorRoot = join(tempDir, 'monitor');
  await mkdir(join(monitorRoot, 'manga'), { recursive: true });
  process.env.MONITOR_ROOT = monitorRoot;
});

afterEach(async () => {
  if (previousMonitorRoot === undefined) delete process.env.MONITOR_ROOT;
  else process.env.MONITOR_ROOT = previousMonitorRoot;
  await rm(tempDir, { recursive: true, force: true });
});

describe('PathSecurityService', () => {
  it('allows a directory inside MONITOR_ROOT', async () => {
    const monitorRoot = process.env.MONITOR_ROOT;
    assert.ok(monitorRoot);

    const result = await PathSecurityService.fromEnv().validateMonitorFolder(join(monitorRoot, 'manga'));

    assert.equal(result.realPath, await realpath(join(monitorRoot, 'manga')));
  });

  it('rejects /etc', async () => {
    await assert.rejects(() => PathSecurityService.fromEnv().validateMonitorFolder('/etc'), (error) => {
      assert.ok(error instanceof PathSecurityError);
      assert.equal(error.code, 'SENSITIVE_PATH');
      assert.match(error.message, /系统敏感路径/);
      return true;
    });
  });

  it('rejects relative path traversal', async () => {
    await assert.rejects(() => PathSecurityService.fromEnv().validateMonitorFolder('../../etc/passwd'), (error) => {
      assert.ok(error instanceof PathSecurityError);
      assert.equal(error.code, 'NOT_ABSOLUTE');
      assert.match(error.message, /绝对路径/);
      return true;
    });
  });

  it('rejects a symlink that resolves outside MONITOR_ROOT', async () => {
    const monitorRoot = process.env.MONITOR_ROOT;
    assert.ok(monitorRoot);
    const linkPath = join(monitorRoot, 'etc-link');
    await symlink('/etc', linkPath);

    await assert.rejects(() => PathSecurityService.fromEnv().validateMonitorFolder(linkPath), (error) => {
      assert.ok(error instanceof PathSecurityError);
      assert.ok(error.code === 'SENSITIVE_PATH' || error.code === 'OUTSIDE_MONITOR_ROOT');
      return true;
    });
  });

  it('resolves relative MONITOR_ROOT from the workspace root when available', () => {
    process.env.MONITOR_ROOT = 'books';
    const normalized = normalizeConfiguredPath(process.env.MONITOR_ROOT);
    assert.equal(normalized, resolve(workspaceRoot(), 'books'));
  });

});

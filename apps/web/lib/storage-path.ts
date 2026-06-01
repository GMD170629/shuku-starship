import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

type ReadablePath = {
  path: string;
  stat: Stats;
};

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean))];
}

function workspaceRootCandidates() {
  return uniquePaths([
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '../..')
  ]);
}

export function storagePathCandidates(path: string) {
  if (isAbsolute(path)) return [path];

  const storageRoot = process.env.STORAGE_ROOT;
  const roots = workspaceRootCandidates();
  const candidates = [
    path,
    resolve(path),
    ...roots.map((root) => join(root, path))
  ];

  if (storageRoot && path === 'storage') {
    candidates.push(isAbsolute(storageRoot) ? storageRoot : resolve(storageRoot));
  } else if (storageRoot && path.startsWith('storage/')) {
    const relativeToStorage = path.slice('storage/'.length);
    candidates.push(join(isAbsolute(storageRoot) ? storageRoot : resolve(storageRoot), relativeToStorage));
  }

  if (path.startsWith('storage/')) {
    candidates.push(...roots.map((root) => join(root, 'workers/scan-worker', path)));
  }

  return uniquePaths(candidates);
}

export async function readableFilePath(path: string): Promise<ReadablePath | null> {
  for (const candidate of storagePathCandidates(path)) {
    const fileStat = await stat(candidate).catch(() => null);
    if (fileStat?.isFile()) return { path: candidate, stat: fileStat };
  }
  return null;
}

export async function requireReadableFilePath(path: string, message = '文件不可读') {
  const readable = await readableFilePath(path);
  if (!readable) throw new Error(message);
  return readable;
}

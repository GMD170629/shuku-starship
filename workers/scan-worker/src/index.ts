import { existsSync, readFileSync } from 'node:fs';
import { access, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { prisma } from '@shuku/database';
import { importManagedBook, isSupportedImportFile, normalizeConfiguredPath, PathSecurityService } from '@shuku/scanner';

const readyFile = '/tmp/scan-worker-ready';
const refreshIntervalMs = Number(process.env.MONITOR_REFRESH_INTERVAL_MS ?? 30_000);
const stableDelayMs = Number(process.env.MONITOR_FILE_STABLE_DELAY_MS ?? 2_000);

type WatchState = {
  watcher: FSWatcher;
  rootPath: string;
  timers: Map<string, NodeJS.Timeout>;
};

const watchers = new Map<string, WatchState>();
const importQueues = new Map<string, Promise<void>>();

function loadEnvFile(path: string, options: { override?: boolean } = {}) {
  if (!existsSync(path)) return;
  const env = readFileSync(path, 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || (!options.override && process.env[match[1]] !== undefined)) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile(join(process.env.INIT_CWD || process.cwd(), '.env'));
loadEnvFile(join(process.cwd(), '../../.env'), { override: process.env.NODE_ENV !== 'production' });
if (process.env.MONITOR_ROOT) process.env.MONITOR_ROOT = normalizeConfiguredPath(process.env.MONITOR_ROOT);
if (process.env.STORAGE_ROOT) process.env.STORAGE_ROOT = normalizeConfiguredPath(process.env.STORAGE_ROOT);
if (process.env.LIBRARY_STORAGE_ROOT) process.env.LIBRARY_STORAGE_ROOT = normalizeConfiguredPath(process.env.LIBRARY_STORAGE_ROOT);

async function startupCheck() {
  for (const name of ['DATABASE_URL', 'MONITOR_ROOT']) {
    if (!process.env[name]) throw new Error(`[import-worker] missing required env ${name}`);
  }
  const monitorRoot = process.env.MONITOR_ROOT;
  if (monitorRoot) {
    const rootStat = await stat(monitorRoot);
    if (!rootStat.isDirectory()) throw new Error(`[import-worker] MONITOR_ROOT is not a directory: ${monitorRoot}`);
    await access(monitorRoot, constants.R_OK);
  }
}

function parseIgnorePatterns(value?: string | null) {
  return (value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function shouldIgnorePath(filePath: string, folder: { ignoreHidden: boolean; ignorePatterns?: string | null }) {
  if (folder.ignoreHidden && filePath.split('/').some((part) => part.length > 1 && part.startsWith('.'))) return true;
  const fileName = basename(filePath);
  return parseIgnorePatterns(folder.ignorePatterns).some((pattern) => fileName.includes(pattern.replaceAll('*', '')));
}

function shouldIgnoreFile(filePath: string, folder: { ignoreHidden: boolean; ignorePatterns?: string | null }) {
  return shouldIgnorePath(filePath, folder) || !isSupportedImportFile(filePath);
}

async function waitForStableFile(filePath: string, minFileSizeBytes: number) {
  const before = await stat(filePath).catch(() => null);
  if (!before?.isFile() || before.size < minFileSizeBytes) return false;
  await new Promise((resolve) => setTimeout(resolve, stableDelayMs));
  const after = await stat(filePath).catch(() => null);
  return Boolean(after?.isFile() && after.size === before.size && after.mtimeMs === before.mtimeMs);
}

async function importWatchedFile(filePath: string, folder: { id: string; minFileSizeBytes: number }) {
  if (!(await waitForStableFile(filePath, folder.minFileSizeBytes))) return;
  try {
    await importManagedBook({
      sourceFilePath: filePath,
      originalName: basename(filePath),
      origin: 'WATCH',
      monitorFolderId: folder.id
    });
  } catch (error) {
    console.error('[import-worker] watched import failed', filePath, error);
  }
}

function importQueueKey(filePath: string, folder: { id: string }) {
  return `${folder.id}:${dirname(resolve(filePath))}`;
}

function enqueueWatchedImport(filePath: string, folder: { id: string; minFileSizeBytes: number }) {
  const key = importQueueKey(filePath, folder);
  const previous = importQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => importWatchedFile(filePath, folder))
    .finally(() => {
      if (importQueues.get(key) === next) importQueues.delete(key);
    });
  importQueues.set(key, next);
  return next;
}

function scheduleImport(filePath: string, folder: { id: string; ignoreHidden: boolean; ignorePatterns?: string | null; minFileSizeBytes: number }, state: WatchState) {
  if (shouldIgnoreFile(filePath, folder)) return;
  const existing = state.timers.get(filePath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.timers.delete(filePath);
    void enqueueWatchedImport(filePath, folder);
  }, stableDelayMs);
  state.timers.set(filePath, timer);
}

async function refreshWatchers() {
  const folders = await prisma.monitorFolder.findMany({ where: { enabled: true }, orderBy: { createdAt: 'desc' } });
  const active = new Set(folders.map((folder) => folder.id));
  for (const [id, state] of watchers) {
    if (!active.has(id)) {
      for (const timer of state.timers.values()) clearTimeout(timer);
      await state.watcher.close();
      watchers.delete(id);
      console.log(`[import-worker] stopped monitor ${state.rootPath}`);
    }
  }

  for (const folder of folders) {
    if (watchers.has(folder.id)) continue;
    let realPath: string;
    try {
      realPath = (await PathSecurityService.fromEnv().validateMonitorFolder(folder.rootPath)).realPath;
    } catch (error) {
      console.error('[import-worker] monitor folder unavailable', folder.rootPath, error);
      continue;
    }
    const state: WatchState = {
      rootPath: realPath,
      watcher: chokidar.watch(realPath, {
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: stableDelayMs, pollInterval: 500 },
        ignored: (path, stats) => stats?.isFile() ? shouldIgnoreFile(path, folder) : shouldIgnorePath(path, folder)
      }),
      timers: new Map()
    };
    state.watcher.on('add', (path) => scheduleImport(path, folder, state));
    state.watcher.on('change', (path) => scheduleImport(path, folder, state));
    state.watcher.on('error', (error) => console.error('[import-worker] watcher error', realPath, error));
    watchers.set(folder.id, state);
    console.log(`[import-worker] monitoring ${realPath}`);
  }
}

await startupCheck();
await refreshWatchers();
const refreshTimer = setInterval(() => void refreshWatchers(), refreshIntervalMs);
await writeFile(readyFile, String(process.pid));
console.log('[import-worker] ready');

async function shutdown(signal: string) {
  console.log(`[import-worker] ${signal} received, closing watchers`);
  clearInterval(refreshTimer);
  await rm(readyFile, { force: true });
  for (const state of watchers.values()) {
    for (const timer of state.timers.values()) clearTimeout(timer);
    await state.watcher.close();
  }
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import ignore from 'ignore';
import { prisma } from '@shuku/database';
import type { Book, BookFile, ReadingFormat, ScanTask } from '@prisma/client';
import { CoverService } from './cover-service.js';
import { PathSecurityService } from './path-security-service.js';

export { PathSecurityError, PathSecurityService } from './path-security-service.js';

export interface ScanTarget {
  scanTaskId: string;
  libraryPathId: string;
  failedPaths?: string[];
}

type FileFingerprint = {
  fingerprint: string;
  fullHash: string | null;
  hashStatus: 'FULL' | 'PARTIAL_PENDING' | 'FAILED';
  mtimeMs: bigint;
  sizeBytes: bigint;
};

type CandidateFile = FileFingerprint & {
  path: string;
  kind: ReadingFormat;
  mimeType: string;
  sortOrder: number;
  filePathHash: string;
};

type Candidate = {
  title: string;
  author?: string;
  format: ReadingFormat;
  sourcePath: string;
  sourceHash: string;
  files: CandidateFile[];
  sizeBytes: bigint;
  pageCount?: number;
};

type WalkResult = {
  files: string[];
  skipped: number;
  errors: Array<{ path: string; error: unknown }>;
};

type CandidateBuildOptions = {
  ignorePatterns?: string | null;
  ignoreHidden: boolean;
  minFileSizeBytes?: number | null;
};

type ScanCounters = {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  duplicateCount: number;
};

class ScanCanceledError extends Error {
  constructor() {
    super('Scan task was canceled');
  }
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002';
}

function summarizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function largeFileThresholdBytes() {
  return Number(process.env.SCAN_LARGE_FILE_THRESHOLD_BYTES ?? 64 * 1024 * 1024);
}

function partialHashChunkBytes() {
  return Number(process.env.SCAN_PARTIAL_HASH_CHUNK_BYTES ?? 1024 * 1024);
}

function normalizeMinFileSizeBytes(value?: number | null) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : 0;
}

const defaultIgnorePatterns = [
  '.DS_Store',
  'Thumbs.db',
  '@eaDir',
  '@eaDir/**',
  '\\#recycle',
  '\\#recycle/**',
  '*.tmp',
  '*.part',
  '*.download',
  '*.nfo',
  '*.url',
  '*.html',
  '*.htm',
  '*.opf',
  '*.log',
  '__MACOSX',
  '__MACOSX/**',
  'cover.*',
  'Cover.*',
  'COVER.*',
  'folder.*',
  'Folder.*',
  'FOLDER.*',
  'poster.*',
  'Poster.*',
  'POSTER.*',
  'thumbnail.*',
  'Thumbnail.*',
  'THUMBNAIL.*',
  'thumb.*',
  'Thumb.*',
  'THUMB.*'
];

const fileTypes: Record<string, { format: ReadingFormat; mimeType: string }> = {
  '.txt': { format: 'TXT', mimeType: 'text/plain; charset=utf-8' },
  '.md': { format: 'TXT', mimeType: 'text/markdown; charset=utf-8' },
  '.markdown': { format: 'TXT', mimeType: 'text/markdown; charset=utf-8' },
  '.pdf': { format: 'PDF', mimeType: 'application/pdf' },
  '.epub': { format: 'EPUB', mimeType: 'application/epub+zip' },
  '.cbz': { format: 'COMIC', mimeType: 'application/vnd.comicbook+zip' },
  '.zip': { format: 'COMIC', mimeType: 'application/zip' }
};

const zipExts = new Set(['.zip', '.cbz']);

function sha256(input: string | Buffer) {
  return createHash('sha256').update(input).digest('hex');
}

function filePathHash(path: string) {
  return sha256(path);
}

function titleFromPath(path: string) {
  return basename(path, extname(path)).replaceAll('_', ' ').replaceAll('-', ' ').trim() || basename(path);
}

function splitAuthorTitle(title: string) {
  const match = /^\[(?<author>[^\]]+)]\s*(?<title>.+)$/.exec(title);
  return {
    author: match?.groups?.author,
    title: match?.groups?.title ?? title
  };
}

function normalizeIgnorePath(rootPath: string, targetPath: string) {
  const value = relative(rootPath, targetPath).split(sep).join('/');
  return value || basename(targetPath);
}

function hasHiddenSegment(rootPath: string, targetPath: string) {
  return normalizeIgnorePath(rootPath, targetPath)
    .split('/')
    .some((part) => part.length > 1 && part.startsWith('.'));
}

export function createIgnoreMatcher(patterns?: string | null) {
  return ignore().add([...defaultIgnorePatterns, ...(patterns ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)]);
}

function shouldIgnorePath(rootPath: string, targetPath: string, matcher: ReturnType<typeof ignore>, ignoreHidden: boolean) {
  const ignorePath = normalizeIgnorePath(rootPath, targetPath);
  return (ignoreHidden && hasHiddenSegment(rootPath, targetPath)) || matcher.ignores(ignorePath);
}

export async function walkFiles(rootPath: string, options: { ignorePatterns?: string | null; ignoreHidden: boolean }): Promise<WalkResult> {
  const matcher = createIgnoreMatcher(options.ignorePatterns);
  const files: string[] = [];
  const errors: WalkResult['errors'] = [];
  let skipped = 0;

  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: directory, error });
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (shouldIgnorePath(rootPath, path, matcher, options.ignoreHidden)) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        skipped += 1;
      }
    }
  }

  await visit(rootPath);
  return { files, skipped, errors };
}

async function readChunk(path: string, position: number, length: number) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFullFile(path: string) {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function hashPartialFile(path: string, size: number) {
  const chunkSize = Math.min(partialHashChunkBytes(), size);
  const middlePosition = Math.max(0, Math.floor(size / 2) - Math.floor(chunkSize / 2));
  const tailPosition = Math.max(0, size - chunkSize);
  const chunks = await Promise.all([readChunk(path, 0, chunkSize), readChunk(path, middlePosition, chunkSize), readChunk(path, tailPosition, chunkSize)]);
  const hash = createHash('sha256');
  hash.update(String(size));
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

async function validateZip(path: string, size: number) {
  if (size < 4) throw new Error('zip file is too small');
  const first = await readChunk(path, 0, 4);
  const startsWithZipSignature =
    first.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    first.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    first.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  if (!startsWithZipSignature) throw new Error('zip signature is invalid');

  const tailLength = Math.min(size, 65557);
  const tail = await readChunk(path, size - tailLength, tailLength);
  if (tail.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) === -1) {
    throw new Error('zip end of central directory was not found');
  }
}

export async function computeFileFingerprint(path: string): Promise<FileFingerprint> {
  const fileStat = await stat(path);
  const size = Number(fileStat.size);
  if (size <= largeFileThresholdBytes()) {
    const fullHash = await hashFullFile(path);
    return {
      fingerprint: `full:${fullHash}`,
      fullHash,
      hashStatus: 'FULL',
      mtimeMs: BigInt(Math.trunc(fileStat.mtimeMs)),
      sizeBytes: BigInt(fileStat.size)
    };
  }
  const partialHash = await hashPartialFile(path, size);
  const mtimeMs = BigInt(Math.trunc(fileStat.mtimeMs));
  return {
    fingerprint: `partial:${fileStat.size}:${mtimeMs}:${partialHash}`,
    fullHash: null,
    hashStatus: 'PARTIAL_PENDING',
    mtimeMs,
    sizeBytes: BigInt(fileStat.size)
  };
}

function aggregateSourceHash(files: CandidateFile[]) {
  return sha256(
    files
      .map((file) => `${file.sortOrder}:${file.kind}:${file.sizeBytes}:${file.mtimeMs}:${file.fingerprint}:${file.fullHash ?? ''}`)
      .join('\n')
  );
}

async function candidateFile(path: string, type: { format: ReadingFormat; mimeType: string }, sortOrder: number): Promise<CandidateFile> {
  const fingerprint = await computeFileFingerprint(path);
  return {
    path,
    kind: type.format,
    mimeType: type.mimeType,
    sortOrder,
    filePathHash: filePathHash(path),
    ...fingerprint
  };
}

async function buildSingleFileCandidate(filePath: string, type: { format: ReadingFormat; mimeType: string }): Promise<Candidate> {
  if (zipExts.has(extname(filePath).toLowerCase())) {
    const fileStat = await stat(filePath);
    await validateZip(filePath, Number(fileStat.size));
  }
  const parsed = splitAuthorTitle(titleFromPath(filePath));
  const file = await candidateFile(filePath, type, 0);
  return {
    title: parsed.title,
    author: parsed.author,
    format: type.format,
    sourcePath: filePath,
    sourceHash: aggregateSourceHash([file]),
    sizeBytes: file.sizeBytes,
    pageCount: type.format === 'PDF' ? 1 : undefined,
    files: [file]
  };
}

export async function buildCandidates(
  rootPath: string,
  options: CandidateBuildOptions
): Promise<{ candidates: Candidate[]; skipped: number; errors: Array<{ path: string; error: unknown }>; totalFiles: number }> {
  const walk = await walkFiles(rootPath, options);
  const candidates: Candidate[] = [];
  const errors = [...walk.errors];
  let skipped = walk.skipped;
  const minFileSizeBytes = normalizeMinFileSizeBytes(options.minFileSizeBytes);

  for (const filePath of walk.files) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size < minFileSizeBytes) {
        skipped += 1;
        continue;
      }
    } catch (error) {
      errors.push({ path: filePath, error });
      continue;
    }
    const type = fileTypes[extname(filePath).toLowerCase()];
    if (!type) {
      skipped += 1;
      continue;
    }
    try {
      candidates.push(await buildSingleFileCandidate(filePath, type));
    } catch (error) {
      errors.push({ path: filePath, error });
    }
  }

  return { candidates, skipped, errors, totalFiles: walk.files.length };
}

async function buildCandidatesForPaths(
  rootPath: string,
  paths: string[],
  options: CandidateBuildOptions
): Promise<{ candidates: Candidate[]; skipped: number; errors: Array<{ path: string; error: unknown }>; totalFiles: number }> {
  const candidates: Candidate[] = [];
  const errors: Array<{ path: string; error: unknown }> = [];
  let skipped = 0;
  let totalFiles = 0;
  const seen = new Set<string>();
  const minFileSizeBytes = normalizeMinFileSizeBytes(options.minFileSizeBytes);

  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const relativePath = relative(rootPath, path);
    if (relativePath.startsWith('..') || relativePath === '..') {
      errors.push({ path, error: new Error('path is outside the library root') });
      continue;
    }
    try {
      const entry = await stat(path);
      if (entry.isDirectory()) {
        const result = await buildCandidates(path, options);
        candidates.push(...result.candidates);
        skipped += result.skipped;
        totalFiles += result.totalFiles;
        errors.push(...result.errors);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      totalFiles += 1;
      if (entry.size < minFileSizeBytes) {
        skipped += 1;
        continue;
      }
      const ext = extname(path).toLowerCase();
      const type = fileTypes[ext];
      if (!type) {
        skipped += 1;
        continue;
      }
      candidates.push(await buildSingleFileCandidate(path, type));
    } catch (error) {
      errors.push({ path, error });
    }
  }

  return { candidates, skipped, errors, totalFiles };
}

async function log(scanTaskId: string, level: string, message: string) {
  await prisma.scanLog.create({ data: { scanTaskId, level, message } });
}

async function updateTask(scanTaskId: string, data: Partial<ScanTask>) {
  await prisma.scanTask.update({ where: { id: scanTaskId }, data });
}

async function assertTaskCanContinue(scanTaskId: string) {
  const current = await prisma.scanTask.findUnique({ where: { id: scanTaskId }, select: { status: true } });
  if (current?.status === 'CANCELED') throw new ScanCanceledError();
}

function startHeartbeat(scanTaskId: string, startedAt: number) {
  let stopped = false;
  async function beat() {
    if (stopped) return;
    try {
      await prisma.scanTask.update({
        where: { id: scanTaskId, status: 'RUNNING' },
        data: { heartbeatAt: new Date(), duration: Date.now() - startedAt }
      });
    } catch {
      stopped = true;
    }
  }
  void beat();
  const timer = setInterval(() => void beat(), 5000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function releaseRunningLock(scanTaskId: string) {
  await prisma.scanTask.updateMany({
    where: { id: scanTaskId },
    data: { runningLockKey: null }
  });
}

async function findExistingBook(candidate: Candidate): Promise<(Book & { files: BookFile[] }) | null> {
  const bySourceHash = await prisma.book.findUnique({ where: { sourceHash: candidate.sourceHash }, include: { files: true } });
  if (bySourceHash) return bySourceHash;

  const byPath = await prisma.book.findFirst({ where: { sourcePath: candidate.sourcePath }, include: { files: true } });
  if (byPath) return byPath;

  for (const file of candidate.files) {
    const match = await prisma.bookFile.findFirst({
      where: {
        OR: [
          ...(file.fullHash ? [{ fullHash: file.fullHash }] : []),
          { fingerprint: file.fingerprint },
          { filePathHash: file.filePathHash },
          { path: file.path }
        ]
      },
      include: { book: { include: { files: true } } }
    });
    if (match?.book) return match.book;
  }

  return null;
}

function hasBookChanged(book: Book & { files: BookFile[] }, candidate: Candidate) {
  return (
    book.sourcePath !== candidate.sourcePath ||
    book.sourceHash !== candidate.sourceHash ||
    book.sizeBytes !== candidate.sizeBytes ||
    book.pageCount !== candidate.pageCount ||
    book.title !== candidate.title ||
    book.format !== candidate.format ||
    candidate.files.some((file) => {
      const existing = book.files.find(
        (bookFile) => bookFile.path === file.path || bookFile.filePathHash === file.filePathHash || bookFile.fingerprint === file.fingerprint || (file.fullHash && bookFile.fullHash === file.fullHash)
      );
      return (
        !existing ||
        existing.path !== file.path ||
        existing.sizeBytes !== file.sizeBytes ||
        existing.mtimeMs !== file.mtimeMs ||
        existing.fingerprint !== file.fingerprint ||
        existing.fullHash !== file.fullHash ||
        existing.hashStatus !== file.hashStatus
      );
    })
  );
}

async function upsertCandidateFiles(bookId: string, files: CandidateFile[]) {
  const seen = new Set<string>();
  for (const file of files) {
    const existing = await prisma.bookFile.findFirst({
      where: {
        OR: [
          { filePathHash: file.filePathHash },
          { path: file.path },
          ...(file.fullHash ? [{ fullHash: file.fullHash }] : []),
          { fingerprint: file.fingerprint }
        ]
      }
    });
    const data = {
      bookId,
      path: file.path,
      filePathHash: file.filePathHash,
      fingerprint: file.fingerprint,
      fullHash: file.fullHash,
      hashStatus: file.hashStatus,
      mtimeMs: file.mtimeMs,
      kind: file.kind,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sortOrder: file.sortOrder
    };
    if (existing) {
      await prisma.bookFile.update({ where: { id: existing.id }, data });
      seen.add(existing.id);
    } else {
      const created = await prisma.bookFile.create({ data });
      seen.add(created.id);
    }
  }
  await prisma.bookFile.deleteMany({ where: { bookId, id: { notIn: [...seen] } } });
}

function queueCoverGeneration(bookId: string, scanTaskId: string) {
  void (async () => {
    try {
      const book = await prisma.book.findUnique({
        where: { id: bookId },
        include: { files: { orderBy: { sortOrder: 'asc' } } }
      });
      if (!book) return;
      const status = await CoverService.generateBookCover(book);
      await log(scanTaskId, status === 'READY' ? 'info' : 'warn', `cover ${status.toLowerCase()}: ${book.sourcePath}`);
    } catch (error) {
      await log(scanTaskId, 'warn', `cover failed: ${bookId}: ${String(error)}`);
    }
  })();
}

async function reconcileCandidate(task: ScanTask, candidate: Candidate, dryRun: boolean): Promise<'created' | 'updated' | 'unchanged'> {
  const existing = await findExistingBook(candidate);
  const changed = existing ? hasBookChanged(existing, candidate) : true;

  if (dryRun) {
    const verb = existing ? (changed ? (existing.sourcePath !== candidate.sourcePath ? 'would move/update' : 'would update') : 'would keep') : 'would create';
    await log(task.id, 'info', `${verb}: ${candidate.sourcePath}`);
    return existing ? (changed ? 'updated' : 'unchanged') : 'created';
  }

  if (!existing) {
    const book = await prisma.book.create({
      data: {
        libraryPathId: task.libraryPathId,
        title: candidate.title,
        author: candidate.author,
        format: candidate.format,
        sourcePath: candidate.sourcePath,
        sourceHash: candidate.sourceHash,
        sizeBytes: candidate.sizeBytes,
        pageCount: candidate.pageCount,
        tags: JSON.stringify([candidate.format.toLowerCase()])
      }
    });
    await upsertCandidateFiles(book.id, candidate.files);
    queueCoverGeneration(book.id, task.id);
    await log(task.id, 'info', `created: ${candidate.sourcePath}`);
    return 'created';
  }

  if (!changed) {
    await log(task.id, 'info', `unchanged: ${candidate.sourcePath}`);
    return 'unchanged';
  }

  const moved = existing.sourcePath !== candidate.sourcePath;
  const book = await prisma.book.update({
    where: { id: existing.id },
    data: {
      libraryPathId: task.libraryPathId,
      title: candidate.title,
      author: candidate.author,
      format: candidate.format,
      sourcePath: candidate.sourcePath,
      sourceHash: candidate.sourceHash,
      sizeBytes: candidate.sizeBytes,
      pageCount: candidate.pageCount,
      hidden: false
    }
  });
  await upsertCandidateFiles(book.id, candidate.files);
  queueCoverGeneration(book.id, task.id);
  await log(task.id, 'info', `${moved ? 'moved' : 'updated'}: ${existing.sourcePath} -> ${candidate.sourcePath}`);
  return 'updated';
}

export async function scanNas(target: ScanTarget) {
  const task = await prisma.scanTask.findUnique({
    where: { id: target.scanTaskId },
    include: { libraryPath: true }
  });
  if (!task) throw new Error(`Scan task not found: ${target.scanTaskId}`);
  if (task.status === 'CANCELED') {
    await log(task.id, 'warn', 'scan skipped: task was canceled before worker start');
    return;
  }
  if (!task.libraryPath.enabled) throw new Error(`Library path is disabled: ${task.libraryPath.rootPath}`);
  const secureRoot = await PathSecurityService.fromEnv().validateLibraryRoot(task.libraryPath.rootPath);
  const dryRun = task.mode === 'DRY_RUN';
  const startedAt = Date.now();
  let stopHeartbeat = () => {};

  try {
    await prisma.scanTask.update({
      where: { id: task.id },
      data: {
        status: 'RUNNING',
        runningLockKey: task.libraryPathId,
        progress: 1,
        heartbeatAt: new Date(),
        duration: 0,
        message: `${dryRun ? 'Dry run：' : ''}${target.failedPaths?.length ? '正在重新扫描失败文件' : `正在扫描 ${secureRoot.realPath}`}`,
        startedAt: new Date(startedAt),
        finishedAt: null,
        errorSummary: null
      }
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      await updateTask(task.id, {
        status: 'WAITING_RESUME',
        message: '同一路径已有运行中的扫描任务，已等待恢复',
        finishedAt: new Date(),
        duration: Date.now() - startedAt,
        errorSummary: '同一路径已有运行中的扫描任务'
      });
      await log(task.id, 'warn', 'scan deferred: another running task holds this library path lock');
      return;
    }
    throw error;
  }

  stopHeartbeat = startHeartbeat(task.id, startedAt);
  await log(task.id, 'info', `${dryRun ? 'dry run ' : ''}scan started: ${secureRoot.realPath}`);

  const counters: ScanCounters = {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    duplicateCount: 0
  };

  try {
    const options = {
      ignorePatterns: task.libraryPath.ignorePatterns,
      ignoreHidden: task.libraryPath.ignoreHidden,
      minFileSizeBytes: task.libraryPath.minFileSizeBytes
    };
    const { candidates, skipped, errors, totalFiles } = target.failedPaths?.length
      ? await buildCandidatesForPaths(secureRoot.realPath, target.failedPaths, options)
      : await buildCandidates(secureRoot.realPath, options);
    await assertTaskCanContinue(task.id);
    counters.skippedCount = skipped;
    counters.errorCount = errors.length;
    const errorMessages: string[] = [];
    for (const error of errors) {
      const message = `${dryRun ? 'would error' : 'error'}: ${error.path}: ${summarizeError(error.error)}`;
      errorMessages.push(message);
      await log(task.id, 'error', message);
    }

    await updateTask(task.id, {
      totalCount: candidates.length,
      totalFiles,
      processedFiles: 0,
      skippedCount: counters.skippedCount,
      errorCount: counters.errorCount,
      duplicateCount: 0,
      errorSummary: errorMessages.slice(0, 5).join('\n') || null
    });

    let processedFiles = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      await assertTaskCanContinue(task.id);
      const candidate = candidates[index];
      try {
        const result = await reconcileCandidate(task, candidate, dryRun);
        if (result === 'created') counters.createdCount += 1;
        if (result === 'updated') counters.updatedCount += 1;
        if (result === 'unchanged') counters.duplicateCount += candidate.files.length;
      } catch (error) {
        counters.errorCount += 1;
        const message = `${dryRun ? 'would error' : 'error'}: ${candidate.sourcePath}: ${summarizeError(error)}`;
        errorMessages.push(message);
        await log(task.id, 'error', message);
      }
      const processedCount = index + 1;
      processedFiles += candidate.files.length;
      await updateTask(task.id, {
        progress: Math.round((processedCount / Math.max(1, candidates.length)) * 100),
        scannedCount: processedCount,
        processedCount,
        totalCount: candidates.length,
        totalFiles,
        processedFiles,
        lastScannedPath: candidate.sourcePath,
        duration: Date.now() - startedAt,
        errorSummary: errorMessages.slice(0, 5).join('\n') || null,
        ...counters
      });
    }

    const failed = counters.errorCount > 0 && counters.createdCount + counters.updatedCount + counters.duplicateCount === 0 && candidates.length === 0;
    await updateTask(task.id, {
      status: failed ? 'FAILED' : 'COMPLETED',
      runningLockKey: null,
      progress: 100,
      scannedCount: candidates.length,
      processedCount: candidates.length,
      totalCount: candidates.length,
      totalFiles,
      processedFiles: totalFiles,
      duration: Date.now() - startedAt,
      errorSummary: errorMessages.slice(0, 5).join('\n') || null,
      ...counters,
      message: `${dryRun ? 'Dry run 完成' : '完成'}：扫描文件 ${totalFiles}，新增 ${counters.createdCount}，更新 ${counters.updatedCount}，跳过 ${counters.skippedCount}，错误 ${counters.errorCount}，重复 ${counters.duplicateCount}`,
      finishedAt: new Date()
    });
    await log(
      task.id,
      'info',
      `${dryRun ? 'dry run ' : ''}scan finished: files=${totalFiles}, created=${counters.createdCount}, updated=${counters.updatedCount}, skipped=${counters.skippedCount}, errors=${counters.errorCount}, duplicates=${counters.duplicateCount}`
    );
  } catch (error) {
    if (error instanceof ScanCanceledError) {
      await updateTask(task.id, {
        status: 'CANCELED',
        runningLockKey: null,
        message: '扫描已取消',
        duration: Date.now() - startedAt,
        finishedAt: new Date()
      });
      await log(task.id, 'warn', 'scan canceled gracefully');
      return;
    }
    await updateTask(task.id, {
      status: 'FAILED',
      runningLockKey: null,
      errorCount: counters.errorCount + 1,
      errorSummary: summarizeError(error),
      message: `扫描失败：${summarizeError(error)}`,
      duration: Date.now() - startedAt,
      finishedAt: new Date()
    });
    await log(task.id, 'error', `scan failed: ${summarizeError(error)}`);
    throw error;
  } finally {
    stopHeartbeat();
    await releaseRunningLock(task.id);
  }
}

export async function recoverStaleRunningScanTasks(options: { staleAfterMs?: number; resume?: boolean } = {}) {
  const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
  const cutoff = new Date(Date.now() - staleAfterMs);
  const status = options.resume ? 'WAITING_RESUME' : 'FAILED';
  const tasks = await prisma.scanTask.findMany({
    where: {
      status: 'RUNNING',
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }]
    },
    select: { id: true, heartbeatAt: true, libraryPath: { select: { rootPath: true } } }
  });

  for (const task of tasks) {
    await prisma.scanTask.update({
      where: { id: task.id },
      data: {
        status,
        runningLockKey: null,
        message: options.resume ? 'Worker 启动时发现遗留任务，等待恢复' : 'Worker 启动时发现心跳超时，已标记失败',
        errorSummary: `超过 ${Math.round(staleAfterMs / 60000)} 分钟无心跳`,
        finishedAt: new Date()
      }
    });
    await log(task.id, 'error', `stale running task recovered: heartbeat=${task.heartbeatAt?.toISOString() ?? 'none'}, path=${task.libraryPath.rootPath}`);
  }

  return tasks.length;
}

import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import type { Book, BookFile, ImportLog, ImportTask, MonitorFolder, ReadingProgress, User } from '@prisma/client';
import yauzl from 'yauzl';
import { prisma } from './prisma';

type BackupKind = 'manual' | 'automatic';

type AutomaticBackupState = {
  lastAutomaticBackupDate?: string;
  lastBackupId?: string;
  updatedAt?: string;
};

type BackupMetadata = {
  id: string;
  kind: BackupKind;
  app: 'shuku-starship';
  version: 1;
  createdAt: string;
  format: 'zip';
  contents: string[];
  scope: string[];
  counts: {
    users: number;
    monitorFolders: number;
    books: number;
    bookFiles: number;
    readingProgresses: number;
    importTasks: number;
    importLogs: number;
    coverIndexEntries: number;
  };
};

type DatabaseExport = {
  users: Array<Omit<User, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }>;
  monitorFolders: Array<Omit<MonitorFolder, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }>;
  books: Array<Omit<Book, 'sizeBytes' | 'createdAt' | 'updatedAt'> & { sizeBytes: string; createdAt: string; updatedAt: string }>;
  bookFiles: Array<Omit<BookFile, 'sizeBytes' | 'mtimeMs' | 'createdAt' | 'updatedAt'> & { sizeBytes: string; mtimeMs: string; createdAt: string; updatedAt: string }>;
  readingProgresses: Array<Omit<ReadingProgress, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }>;
  importTasks: Array<Omit<ImportTask, 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'> & {
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  importLogs: Array<Omit<ImportLog, 'createdAt'> & { createdAt: string }>;
  coverIndex: Array<{
    bookId: string;
    coverPath: string | null;
    coverStatus: string;
  }>;
};

type SettingsExport = {
  monitorFolders: DatabaseExport['monitorFolders'];
  storageRoot: string;
  backupRoot: string;
  automaticBackup: {
    time: '03:00';
    retentionCount: 7;
  };
};

export type BackupListItem = {
  id: string;
  kind: BackupKind | 'unknown';
  filename: string;
  sizeBytes: number;
  createdAt: string;
  counts?: BackupMetadata['counts'];
};

const backupContents = ['metadata.json', 'database-export.json', 'settings.json'];
const backupIdPattern = /^(manual|automatic)-\d{8}-\d{6}-[a-z0-9]+$/;
let schedulerStarted = false;

function storageRoot() {
  return process.env.STORAGE_ROOT || process.env.STORAGE_DIR || join(process.cwd(), 'storage');
}

function backupsRoot() {
  return join(storageRoot(), 'backups');
}

function statePath() {
  return join(backupsRoot(), '.automatic-state.json');
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function backupId(kind: BackupKind, date = new Date()) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${kind}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertBackupId(id: string) {
  if (!backupIdPattern.test(id)) throw new Error('INVALID_BACKUP_ID');
}

function backupPath(id: string) {
  assertBackupId(id);
  return join(backupsRoot(), `${id}.zip`);
}

function jsonStringify(value: unknown) {
  return JSON.stringify(
    value,
    (_key, data) => {
      if (typeof data === 'bigint') return data.toString();
      if (data instanceof Date) return data.toISOString();
      return data;
    },
    2
  );
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function createZip(entries: Array<{ name: string; data: Buffer }>, now = new Date()) {
  const chunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const { time, date } = dosDateTime(now);
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const checksum = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, name);

    offset += localHeader.length + name.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralDirectory, end]);
}

function readZipEntries(path: string) {
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zipfile) => {
      if (openError) {
        reject(openError);
        return;
      }
      if (!zipfile) {
        reject(new Error('无法读取备份文件'));
        return;
      }

      const entries = new Map<string, Buffer>();
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zipfile.close();
            reject(streamError ?? new Error(`无法读取 ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

function parseJsonEntry<T>(entries: Map<string, Buffer>, name: string): T {
  const entry = entries.get(name);
  if (!entry) throw new Error(`备份缺少 ${name}`);
  return JSON.parse(entry.toString('utf8')) as T;
}

async function readBackupMetadata(path: string) {
  try {
    const entries = await readZipEntries(path);
    return parseJsonEntry<BackupMetadata>(entries, 'metadata.json');
  } catch {
    return null;
  }
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function hasPassedAutomaticTime(date = new Date()) {
  return date.getHours() > 3 || (date.getHours() === 3 && date.getMinutes() >= 0);
}

function toDate(value: string) {
  return new Date(value);
}

function toBigInt(value: string | number | bigint) {
  return BigInt(value);
}

export class BackupService {
  static backupDirectory() {
    return backupsRoot();
  }

  static backupFilePath(id: string) {
    return backupPath(id);
  }

  static async createBackup(kind: BackupKind = 'manual') {
    await mkdir(backupsRoot(), { recursive: true });
    const createdAt = new Date();
    const id = backupId(kind, createdAt);
    const [users, monitorFolders, books, bookFiles, readingProgresses, importTasks, importLogs] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.monitorFolder.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.book.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.bookFile.findMany({ orderBy: [{ bookId: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.readingProgress.findMany({ orderBy: { updatedAt: 'desc' } }),
      prisma.importTask.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.importLog.findMany({ orderBy: { createdAt: 'asc' } })
    ]);

    const databaseExport: DatabaseExport = {
      users: JSON.parse(jsonStringify(users)),
      monitorFolders: JSON.parse(jsonStringify(monitorFolders)),
      books: JSON.parse(jsonStringify(books)),
      bookFiles: JSON.parse(jsonStringify(bookFiles)),
      readingProgresses: JSON.parse(jsonStringify(readingProgresses)),
      importTasks: JSON.parse(jsonStringify(importTasks)),
      importLogs: JSON.parse(jsonStringify(importLogs)),
      coverIndex: books.map((book) => ({
        bookId: book.id,
        coverPath: book.coverPath,
        coverStatus: book.coverStatus
      }))
    };

    const metadata: BackupMetadata = {
      id,
      kind,
      app: 'shuku-starship',
      version: 1,
      createdAt: createdAt.toISOString(),
      format: 'zip',
      contents: backupContents,
      scope: ['database', 'reading-metadata', 'tags', 'reading-progress', 'monitor-folder-settings', 'cover-cache-index'],
      counts: {
        users: users.length,
        monitorFolders: monitorFolders.length,
        books: books.length,
        bookFiles: bookFiles.length,
        readingProgresses: readingProgresses.length,
        importTasks: importTasks.length,
        importLogs: importLogs.length,
        coverIndexEntries: books.length
      }
    };

    const settings: SettingsExport = {
      monitorFolders: databaseExport.monitorFolders,
      storageRoot: storageRoot(),
      backupRoot: backupsRoot(),
      automaticBackup: {
        time: '03:00',
        retentionCount: 7
      }
    };

    const zip = createZip([
      { name: 'metadata.json', data: Buffer.from(jsonStringify(metadata), 'utf8') },
      { name: 'database-export.json', data: Buffer.from(jsonStringify(databaseExport), 'utf8') },
      { name: 'settings.json', data: Buffer.from(jsonStringify(settings), 'utf8') }
    ], createdAt);

    await writeFile(backupPath(id), zip);
    if (kind === 'automatic') await this.pruneAutomaticBackups(7);
    return { ...metadata, filename: `${id}.zip`, sizeBytes: zip.length };
  }

  static async listBackups(): Promise<BackupListItem[]> {
    await mkdir(backupsRoot(), { recursive: true });
    const files = await readdir(backupsRoot());
    const backups = await Promise.all(
      files
        .filter((file) => file.endsWith('.zip'))
        .map(async (file) => {
          const path = join(backupsRoot(), file);
          const fileStat = await stat(path);
          const metadata = await readBackupMetadata(path);
          return {
            id: metadata?.id ?? basename(file, '.zip'),
            kind: metadata?.kind ?? 'unknown',
            filename: file,
            sizeBytes: fileStat.size,
            createdAt: metadata?.createdAt ?? fileStat.mtime.toISOString(),
            counts: metadata?.counts
          } satisfies BackupListItem;
        })
    );
    return backups.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  static async createDownloadStream(id: string) {
    const path = backupPath(id);
    const fileStat = await stat(path);
    return {
      filename: `${id}.zip`,
      sizeBytes: fileStat.size,
      stream: Readable.toWeb(createReadStream(path)) as ReadableStream
    };
  }

  static async deleteBackup(id: string) {
    await rm(backupPath(id), { force: true });
  }

  static async restoreBackup(id: string) {
    const entries = await readZipEntries(backupPath(id));
    const metadata = parseJsonEntry<BackupMetadata>(entries, 'metadata.json');
    const databaseExport = parseJsonEntry<DatabaseExport>(entries, 'database-export.json');
    if (metadata.app !== 'shuku-starship' || metadata.version !== 1) {
      throw new Error('备份格式不兼容');
    }

    await prisma.$transaction(async (tx) => {
      await tx.readingProgress.deleteMany();
      await tx.importLog.deleteMany();
      await tx.importTask.deleteMany();
      await tx.bookFile.deleteMany();
      await tx.book.deleteMany();
      await tx.monitorFolder.deleteMany();

      for (const user of databaseExport.users) {
        await tx.user.upsert({
          where: { id: user.id },
          create: {
            ...user,
            createdAt: toDate(user.createdAt),
            updatedAt: toDate(user.updatedAt)
          },
          update: {
            email: user.email,
            name: user.name,
            passwordHash: user.passwordHash,
            role: user.role,
            updatedAt: toDate(user.updatedAt)
          }
        });
      }

      for (const path of databaseExport.monitorFolders) {
        await tx.monitorFolder.create({
          data: {
            ...path,
            createdAt: toDate(path.createdAt),
            updatedAt: toDate(path.updatedAt)
          }
        });
      }

      for (const book of databaseExport.books) {
        await tx.book.create({
          data: {
            ...book,
            sizeBytes: toBigInt(book.sizeBytes),
            createdAt: toDate(book.createdAt),
            updatedAt: toDate(book.updatedAt)
          }
        });
      }

      for (const file of databaseExport.bookFiles) {
        await tx.bookFile.create({
          data: {
            ...file,
            sizeBytes: toBigInt(file.sizeBytes),
            mtimeMs: toBigInt(file.mtimeMs),
            createdAt: toDate(file.createdAt),
            updatedAt: toDate(file.updatedAt)
          }
        });
      }

      for (const progress of databaseExport.readingProgresses) {
        await tx.readingProgress.create({
          data: {
            ...progress,
            createdAt: toDate(progress.createdAt),
            updatedAt: toDate(progress.updatedAt)
          }
        });
      }

      for (const task of databaseExport.importTasks ?? []) {
        await tx.importTask.create({
          data: {
            ...task,
            startedAt: task.startedAt ? toDate(task.startedAt) : null,
            finishedAt: task.finishedAt ? toDate(task.finishedAt) : null,
            createdAt: toDate(task.createdAt),
            updatedAt: toDate(task.updatedAt)
          }
        });
      }

      for (const log of databaseExport.importLogs ?? []) {
        await tx.importLog.create({
          data: {
            ...log,
            createdAt: toDate(log.createdAt)
          }
        });
      }
    }, { timeout: 30_000 });

    return {
      id,
      restoredAt: new Date().toISOString(),
      counts: metadata.counts
    };
  }

  static async ensureAutomaticBackup() {
    await mkdir(backupsRoot(), { recursive: true });
    const now = new Date();
    if (!hasPassedAutomaticTime(now)) return null;

    const key = todayKey(now);
    const state = await readFile(statePath(), 'utf8').then((content) => JSON.parse(content) as AutomaticBackupState).catch(() => ({} as AutomaticBackupState));
    if (state.lastAutomaticBackupDate === key) return null;

    const backup = await this.createBackup('automatic');
    await writeFile(statePath(), jsonStringify({ lastAutomaticBackupDate: key, lastBackupId: backup.id, updatedAt: new Date().toISOString() }));
    return backup;
  }

  static startAutomaticScheduler() {
    if (
      schedulerStarted ||
      process.env.BACKUP_AUTO_DISABLED === 'true' ||
      process.env.NEXT_PHASE === 'phase-production-build' ||
      !process.env.DATABASE_URL
    ) {
      return;
    }
    schedulerStarted = true;
    const run = () => {
      this.ensureAutomaticBackup().catch((error) => console.error('[backup-scheduler]', error));
    };
    run();
    setInterval(run, 30 * 60 * 1000).unref?.();
  }

  static async pruneAutomaticBackups(retentionCount: number) {
    const backups = (await this.listBackups()).filter((backup) => backup.kind === 'automatic');
    const stale = backups.slice(retentionCount);
    await Promise.all(stale.map((backup) => this.deleteBackup(backup.id)));
  }
}

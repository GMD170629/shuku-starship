import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { archiveIndexPath, ensureArchiveIndex, streamArchivePageResponse } from './archive-index';

let tempDir = '';
let previousStorageDir: string | undefined;
let previousStorageRoot: string | undefined;

afterEach(async () => {
  if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorageDir;
  if (previousStorageRoot === undefined) delete process.env.STORAGE_ROOT;
  else process.env.STORAGE_ROOT = previousStorageRoot;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: Array<{ name: string; data: string }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

describe('archive index cache', () => {
  it('indexes only images in natural order and reuses the cache file', async () => {
    previousStorageDir = process.env.STORAGE_DIR;
    previousStorageRoot = process.env.STORAGE_ROOT;
    tempDir = await mkdtemp(join(tmpdir(), 'shuku-archive-index-'));
    process.env.STORAGE_ROOT = join(tempDir, 'storage');

    const archivePath = join(tempDir, 'comic.cbz');
    await writeFile(
      archivePath,
      createStoredZip([
        { name: 'page-10.jpg', data: 'ten' },
        { name: 'notes.txt', data: 'skip' },
        { name: 'page-2.png', data: 'two' }
      ])
    );

    const first = await ensureArchiveIndex('book1', 'file1', archivePath);
    assert.equal(first.pages.length, 2);
    assert.deepEqual(
      first.pages.map((page) => ({ pageIndex: page.pageIndex, mimeType: page.mimeType })),
      [
        { pageIndex: 1, mimeType: 'image/png' },
        { pageIndex: 2, mimeType: 'image/jpeg' }
      ]
    );

    const cachePayload = await readFile(archiveIndexPath('book1', 'file1', first.source.size, first.source.mtimeMs), 'utf8');
    assert.equal(JSON.parse(cachePayload).pages[0].name, 'page-2.png');

    const second = await ensureArchiveIndex('book1', 'file1', archivePath);
    assert.deepEqual(second.pages, first.pages);
  });

  it('streams an indexed page without exposing the archive entry name in the response', async () => {
    previousStorageDir = process.env.STORAGE_DIR;
    previousStorageRoot = process.env.STORAGE_ROOT;
    tempDir = await mkdtemp(join(tmpdir(), 'shuku-archive-page-'));
    process.env.STORAGE_ROOT = join(tempDir, 'storage');

    const archivePath = join(tempDir, 'comic.cbz');
    await writeFile(
      archivePath,
      createStoredZip([
        { name: 'page-1.png', data: 'first-image' },
        { name: 'page-2.png', data: 'second-image' }
      ])
    );

    const index = await ensureArchiveIndex('book2', 'file2', archivePath);
    const response = await streamArchivePageResponse({
      request: new Request('http://local/api/books/book2/pages/2'),
      userId: 'user1',
      bookId: 'book2',
      fileId: 'file2',
      path: archivePath,
      index,
      pageIndex: 2
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.equal(response.headers.has('Content-Disposition'), false);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), 'second-image');
  });
});

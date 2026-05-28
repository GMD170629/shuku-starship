import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import JSZip from 'jszip';
import { buildCandidates, computeFileFingerprint, walkFiles } from './index';

let tempDir = '';
let previousThreshold: string | undefined;
let previousChunkSize: string | undefined;

async function writeZip(path: string) {
  const zip = new JSZip();
  zip.file('page-001.txt', 'ok');
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

beforeEach(async () => {
  previousThreshold = process.env.SCAN_LARGE_FILE_THRESHOLD_BYTES;
  previousChunkSize = process.env.SCAN_PARTIAL_HASH_CHUNK_BYTES;
  tempDir = await mkdtemp(join(process.cwd(), 'scanner-'));
});

afterEach(async () => {
  if (previousThreshold === undefined) delete process.env.SCAN_LARGE_FILE_THRESHOLD_BYTES;
  else process.env.SCAN_LARGE_FILE_THRESHOLD_BYTES = previousThreshold;
  if (previousChunkSize === undefined) delete process.env.SCAN_PARTIAL_HASH_CHUNK_BYTES;
  else process.env.SCAN_PARTIAL_HASH_CHUNK_BYTES = previousChunkSize;
  await rm(tempDir, { recursive: true, force: true });
});

describe('scanner file discovery', () => {
  it('keeps Chinese paths, spaces, and special symbols intact', async () => {
    const dir = join(tempDir, '漫画 库 (2026)');
    const filePath = join(dir, '银河 星舰 [第一卷] #01.txt');
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, 'hello');

    const result = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null });

    assert.equal(result.errors.length, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sourcePath, filePath);
    assert.equal(result.candidates[0].title, '银河 星舰 [第一卷] #01');
  });

  it('applies default NAS ignore rules and custom ignore patterns', async () => {
    await mkdir(join(tempDir, '@eaDir'), { recursive: true });
    await mkdir(join(tempDir, '#recycle'), { recursive: true });
    await writeFile(join(tempDir, '.DS_Store'), '');
    await writeFile(join(tempDir, 'Thumbs.db'), '');
    await writeFile(join(tempDir, 'book.tmp'), '');
    await writeFile(join(tempDir, 'book.part'), '');
    await writeFile(join(tempDir, 'book.download'), '');
    await writeFile(join(tempDir, '@eaDir', 'ignored.txt'), '');
    await writeFile(join(tempDir, '#recycle', 'ignored.txt'), '');
    await writeFile(join(tempDir, 'skip-me.pdf'), '');
    await writeFile(join(tempDir, 'keep.txt'), 'ok');

    const result = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: 'skip-*.pdf' });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.candidates.map((candidate) => candidate.sourcePath), [join(tempDir, 'keep.txt')]);
    assert.equal(result.skipped, 8);
  });

  it('can include or skip hidden files and directories', async () => {
    await mkdir(join(tempDir, '.secret'), { recursive: true });
    await writeFile(join(tempDir, '.hidden.txt'), 'hidden');
    await writeFile(join(tempDir, '.secret', 'inside.txt'), 'inside');
    await writeFile(join(tempDir, 'visible.txt'), 'visible');

    const hiddenSkipped = await walkFiles(tempDir, { ignoreHidden: true, ignorePatterns: null });
    const hiddenIncluded = await walkFiles(tempDir, { ignoreHidden: false, ignorePatterns: null });

    assert.deepEqual(hiddenSkipped.files, [join(tempDir, 'visible.txt')]);
    assert.equal(hiddenIncluded.files.length, 3);
  });

  it('uses full hashes for small files and partial fingerprints for large files', async () => {
    process.env.SCAN_LARGE_FILE_THRESHOLD_BYTES = '16';
    process.env.SCAN_PARTIAL_HASH_CHUNK_BYTES = '4';
    const smallPath = join(tempDir, 'small.txt');
    const largePath = join(tempDir, 'large.txt');
    await writeFile(smallPath, 'small');
    await writeFile(largePath, '0123456789abcdefghijklmnop');

    const small = await computeFileFingerprint(smallPath);
    const large = await computeFileFingerprint(largePath);

    assert.equal(small.hashStatus, 'FULL');
    assert.ok(small.fullHash);
    assert.equal(small.fingerprint, `full:${small.fullHash}`);
    assert.equal(large.hashStatus, 'PARTIAL_PENDING');
    assert.equal(large.fullHash, null);
    assert.match(large.fingerprint, /^partial:/);
  });

  it('reports corrupt zip/cbz files without throwing out of candidate building', async () => {
    const corruptZip = join(tempDir, '损坏 漫画.cbz');
    const goodText = join(tempDir, '正常.txt');
    await writeFile(corruptZip, 'not a zip');
    await writeFile(goodText, 'ok');

    const result = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sourcePath, goodText);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].path, corruptZip);
  });

  it('recognizes only book-like files and skips ordinary images', async () => {
    await mkdir(join(tempDir, 'images'), { recursive: true });
    await writeFile(join(tempDir, 'novel.txt'), 'long enough text');
    await writeFile(join(tempDir, 'notes.md'), 'long enough markdown');
    await writeFile(join(tempDir, 'doc.pdf'), '%PDF-1.4\nbody');
    await writeFile(join(tempDir, 'ebook.epub'), 'epub placeholder');
    await writeZip(join(tempDir, 'comic.cbz'));
    await writeZip(join(tempDir, 'archive.zip'));
    await writeFile(join(tempDir, 'cover.jpg'), 'cover image');
    await writeFile(join(tempDir, 'photo.png'), 'plain image');
    await writeFile(join(tempDir, 'images', 'page-001.jpg'), 'page one');
    await writeFile(join(tempDir, 'images', 'page-002.jpg'), 'page two');

    const result = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.format).sort(),
      ['COMIC', 'COMIC', 'EPUB', 'PDF', 'TXT', 'TXT']
    );
    assert.equal(result.skipped, 4);
  });

  it('skips supported files smaller than the configured minimum size', async () => {
    await writeFile(join(tempDir, 'tiny.txt'), '123456789');
    await writeFile(join(tempDir, 'large.txt'), '1234567890');

    const result = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null, minFileSizeBytes: 10 });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.candidates.map((candidate) => candidate.sourcePath), [join(tempDir, 'large.txt')]);
    assert.equal(result.skipped, 1);
  });

  it('keeps the same source hash when a file is moved by rename', async () => {
    const firstDir = join(tempDir, '第一层');
    const secondDir = join(tempDir, '第二层');
    const firstPath = join(firstDir, '移动测试.txt');
    const secondPath = join(secondDir, '移动测试.txt');
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await writeFile(firstPath, 'same content');

    const before = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null });
    await rename(firstPath, secondPath);
    const after = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null });

    assert.equal(before.candidates.length, 1);
    assert.equal(after.candidates.length, 1);
    assert.equal(before.candidates[0].sourceHash, after.candidates[0].sourceHash);
    assert.equal(after.candidates[0].sourcePath, secondPath);
  });

  it('changes the source hash when a file changes at the same path', async () => {
    const filePath = join(tempDir, '变更测试.txt');
    await writeFile(filePath, 'before');
    const before = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null });

    await writeFile(filePath, 'after');
    const after = await buildCandidates(tempDir, { ignoreHidden: true, ignorePatterns: null });

    assert.equal(before.candidates.length, 1);
    assert.equal(after.candidates.length, 1);
    assert.notEqual(before.candidates[0].sourceHash, after.candidates[0].sourceHash);
  });
});

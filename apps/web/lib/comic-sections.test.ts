import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildComicSections, unitsForComicSection } from './comic-sections';

const baseDate = new Date('2026-01-01T00:00:00Z');

function file(id: string, path: string, sortOrder: number) {
  return {
    id,
    bookId: 'book',
    path,
    filePathHash: null,
    fingerprint: null,
    fullHash: null,
    hashStatus: 'FULL' as const,
    mtimeMs: BigInt(0),
    kind: 'COMIC' as const,
    mimeType: 'application/zip',
    sizeBytes: BigInt(1),
    sortOrder,
    createdAt: baseDate,
    updatedAt: baseDate
  };
}

function page(id: string, filePath: string, href: string, pageInSection: number, metadata: Record<string, unknown> = {}) {
  return {
    id,
    bookId: 'book',
    unitType: 'page',
    title: `第 ${pageInSection} 页`,
    href,
    filePath,
    mediaType: 'image/jpeg',
    sortOrder: pageInSection,
    width: null,
    height: null,
    size: null,
    metadataJson: JSON.stringify({ pageInSection, ...metadata }),
    createdAt: baseDate,
    updatedAt: baseDate
  };
}

describe('comic sections', () => {
  it('builds volume sections from multiple comic files', () => {
    const files = [file('v2', '/managed/vol2.zip', 1), file('v1', '/managed/vol1.zip', 0)];
    const pages = [
      page('p1', '/managed/vol1.zip', '001.jpg', 1, { volumeIndex: 1, sectionTitle: '第 1 卷' }),
      page('p2', '/managed/vol2.zip', '001.jpg', 1, { volumeIndex: 2, sectionTitle: '第 2 卷' }),
      page('p3', '/managed/vol2.zip', '002.jpg', 2, { volumeIndex: 2, sectionTitle: '第 2 卷' })
    ];

    const sections = buildComicSections('book', files, pages);

    assert.deepEqual(sections.map((section) => ({ id: section.id, title: section.title, pageCount: section.pageCount })), [
      { id: 'file:v1', title: '第 1 卷', pageCount: 1 },
      { id: 'file:v2', title: '第 2 卷', pageCount: 2 }
    ]);
    assert.deepEqual(unitsForComicSection(sections[1], pages).map((unit) => unit.id), ['p2', 'p3']);
  });

  it('builds chapter sections from top-level folders in a single comic file', () => {
    const files = [file('single', '/managed/comic.zip', 0)];
    const pages = [
      page('p1', '/managed/comic.zip', '第01话/001.jpg', 1),
      page('p2', '/managed/comic.zip', '第02话/001.jpg', 1)
    ];

    const sections = buildComicSections('book', files, pages);

    assert.deepEqual(sections.map((section) => section.title), ['第01话', '第02话']);
    assert.equal(unitsForComicSection(sections[0], pages).length, 1);
  });
});

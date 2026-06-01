import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMetadataFromFileName } from './organize-pipeline';

describe('parseMetadataFromFileName', () => {
  it('parses Chinese volume markers', () => {
    assert.deepEqual(parseMetadataFromFileName('/books/银河铁道/银河铁道 第3卷.cbz'), {
      title: '银河铁道',
      author: null,
      seriesName: '银河铁道',
      seriesIndex: 3,
      publishedYear: null
    });
  });

  it('parses Vol and v markers', () => {
    assert.equal(parseMetadataFromFileName('/books/comics/星舰 Vol.4.zip').seriesIndex, 4);
    assert.equal(parseMetadataFromFileName('/books/comics/星舰 v05.zip').seriesIndex, 5);
  });

  it('parses title-author names', () => {
    const parsed = parseMetadataFromFileName('/books/ebook/黑暗坡食人树 - （日）岛田庄司.epub');
    assert.equal(parsed.title, '黑暗坡食人树');
    assert.equal(parsed.author, '岛田庄司');
  });

  it('parses published year from file or parent folder', () => {
    assert.equal(parseMetadataFromFileName('/books/1999/星舰.epub').publishedYear, 1999);
    assert.equal(parseMetadataFromFileName('/books/星舰 2024.epub').publishedYear, 2024);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseComicVolumeFromName } from './managed-import';

describe('parseComicVolumeFromName', () => {
  it('parses sibling comic archive volumes as the same series', () => {
    for (let index = 1; index <= 5; index += 1) {
      assert.deepEqual(parseComicVolumeFromName(`/books/[FX战士久留美]/FX戰士久留美 (${index}).zip`), {
        seriesName: 'FX戰士久留美',
        seriesIndex: index,
        title: `FX戰士久留美 (${index})`
      });
    }
  });

  it('supports common volume markers', () => {
    assert.equal(parseComicVolumeFromName('作品（2）.zip')?.seriesIndex, 2);
    assert.equal(parseComicVolumeFromName('作品 第3卷.cbz')?.seriesIndex, 3);
    assert.equal(parseComicVolumeFromName('作品 Vol.4.zip')?.seriesIndex, 4);
    assert.equal(parseComicVolumeFromName('作品 v05.zip')?.seriesIndex, 5);
  });

  it('does not assign a series to archives without a volume marker', () => {
    assert.equal(parseComicVolumeFromName('/books/comics/单本漫画.zip'), null);
  });
});

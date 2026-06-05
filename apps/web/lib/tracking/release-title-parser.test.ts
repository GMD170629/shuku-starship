import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseReleaseTitle } from './release-title-parser';

describe('parseReleaseTitle', () => {
  const cases: Array<{
    name: string;
    input: string;
    expected: Partial<ReturnType<typeof parseReleaseTitle>>;
  }> = [
    { name: 'Chinese novel chapter with epub', input: '某小说 第12章.epub', expected: { normalizedTitle: '某小说', chapter: 12, format: 'epub' } },
    { name: 'Chinese chapter with spaces', input: '某小说 第 12 章', expected: { normalizedTitle: '某小说', chapter: 12 } },
    { name: 'Chinese padded chapter', input: '某小说 第001章.txt', expected: { normalizedTitle: '某小说', chapter: 1, format: 'txt' } },
    { name: 'English chapter', input: 'Title Chapter 12.pdf', expected: { normalizedTitle: 'Title', chapter: 12, format: 'pdf' } },
    { name: 'English Ch padded', input: 'Title Ch.012.epub', expected: { normalizedTitle: 'Title', chapter: 12, format: 'epub' } },
    { name: 'compact c chapter', input: 'Title c012.txt', expected: { normalizedTitle: 'Title', chapter: 12, format: 'txt' } },
    { name: 'Chinese comic chapter', input: '某漫画 第45话.zip', expected: { normalizedTitle: '某漫画', chapter: 45, format: 'zip' } },
    { name: 'Japanese style episode character', input: '某漫画 第45話.cbz', expected: { normalizedTitle: '某漫画', chapter: 45, format: 'cbz' } },
    { name: 'Chinese comic chapter with spaces', input: '某漫画 第 45 话', expected: { normalizedTitle: '某漫画', chapter: 45 } },
    { name: 'Chinese volume padded', input: '某漫画 第03卷.cbz', expected: { normalizedTitle: '某漫画', volume: 3, format: 'cbz' } },
    { name: 'Vol padded', input: 'Title Vol.03.cbz', expected: { normalizedTitle: 'Title', volume: 3, format: 'cbz' } },
    { name: 'Volume word', input: 'Title Volume 3.zip', expected: { normalizedTitle: 'Title', volume: 3, format: 'zip' } },
    { name: 'compact v volume', input: 'Title v03.rar', expected: { normalizedTitle: 'Title', volume: 3, format: 'rar' } },
    { name: 'dash numeric comic chapter', input: '作品名 - 045.zip', expected: { normalizedTitle: '作品名', chapter: 45, format: 'zip' } },
    { name: 'group language comic', input: '[某组] 某漫画 第45话 [简中].zip', expected: { normalizedTitle: '某漫画', group: '某组', chapter: 45, language: '简中', format: 'zip' } },
    { name: 'English group language', input: '[Group] Title Ch.045 [Chinese]', expected: { normalizedTitle: 'Title', group: 'Group', chapter: 45, language: '中文' } },
    { name: 'mixed vol and chapter', input: 'Title Vol.03 Ch.045.cbz', expected: { normalizedTitle: 'Title', volume: 3, chapter: 45, format: 'cbz' } },
    { name: 'traditional Chinese language', input: '[漢化組] 作品 第10話 [繁中].zip', expected: { normalizedTitle: '作品', group: '漢化組', chapter: 10, language: '繁中', format: 'zip' } },
    { name: 'JP tag', input: '[RawGroup] Title Ch.005 [JP].zip', expected: { normalizedTitle: 'Title', group: 'RawGroup', chapter: 5, language: 'JP', format: 'zip' } },
    { name: 'EN tag', input: '[Scan] Title Chapter 7 [EN].cbz', expected: { normalizedTitle: 'Title', group: 'Scan', chapter: 7, language: 'EN', format: 'cbz' } },
    { name: 'quality tag', input: '[Group] Title - 012 [1080p][简中].zip', expected: { normalizedTitle: 'Title', group: 'Group', chapter: 12, language: '简中', quality: '1080P', format: 'zip' } },
    { name: 'underscore noise', input: '[Group]_Title_Name_Ch.009_[Chinese].7z', expected: { normalizedTitle: 'Title Name', group: 'Group', chapter: 9, language: '中文', format: '7z' } },
    { name: 'path input strips directories', input: '/books/comics/[组名] 作品名 第45话 [简中].zip', expected: { normalizedTitle: '作品名', group: '组名', chapter: 45, language: '简中', format: 'zip' } },
    { name: 'episode support', input: 'Show EP.08 [EN].rar', expected: { normalizedTitle: 'Show', episode: 8, language: 'EN', format: 'rar' } }
  ];

  for (const item of cases) {
    it(item.name, () => {
      const parsed = parseReleaseTitle(item.input);
      for (const [key, value] of Object.entries(item.expected)) {
        assert.deepEqual(parsed[key as keyof typeof parsed], value);
      }
      assert.equal(parsed.rawTitle, item.input);
      assert.ok(parsed.aliases.includes(parsed.normalizedTitle));
    });
  }

  it('returns format as a tag', () => {
    assert.ok(parseReleaseTitle('某小说 第12章.epub').tags.includes('epub'));
  });

  it('keeps title alias without book marks', () => {
    const parsed = parseReleaseTitle('《某小说》 第12章.epub');
    assert.equal(parsed.normalizedTitle, '某小说');
    assert.ok(parsed.aliases.includes('某小说'));
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidateToSuggestions, metadataRefreshProvidersFromSettings, normalizeAiSuggestionConfidence, parseDoubanSearchHtml, parseDoubanSubjectHtml, parseMetadataFromFileName, safeCacheQueryKey } from './organize-pipeline';

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

  it('uses parent folder metadata for pure volume archive names', () => {
    const parsed = parseMetadataFromFileName('/monitor/野生的最终BOSS出现了/Vol.08.zip');
    assert.equal(parsed.title, '野生的最终BOSS出现了');
    assert.equal(parsed.seriesName, '野生的最终BOSS出现了');
    assert.equal(parsed.seriesIndex, 8);
  });

  it('keeps pure sibling volume numbers distinct', () => {
    const root = '/monitor/星舰漫画';
    assert.deepEqual(
      ['Vol.06.zip', 'Vol.07.zip', 'Vol.08.zip'].map((name) => parseMetadataFromFileName(`${root}/${name}`).seriesIndex),
      [6, 7, 8]
    );
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

describe('metadata auto refresh policy', () => {
  it('selects enabled import metadata providers from settings', () => {
    assert.deepEqual(metadataRefreshProvidersFromSettings({}), []);
    assert.deepEqual(metadataRefreshProvidersFromSettings({ 'metadata.external.enabled': 'true' }), ['external']);
    assert.deepEqual(metadataRefreshProvidersFromSettings({ 'metadata.ai.enabled': '1' }), ['ai']);
    assert.deepEqual(metadataRefreshProvidersFromSettings({ 'metadata.external.enabled': 'true', 'metadata.ai.enabled': 'on' }), ['external', 'ai']);
  });

  it('caps AI confidence below the high-confidence auto-apply threshold', () => {
    assert.equal(normalizeAiSuggestionConfidence(1), 0.74);
    assert.equal(normalizeAiSuggestionConfidence(0.81), 0.74);
    assert.equal(normalizeAiSuggestionConfidence(undefined), 0.6);
    assert.equal(normalizeAiSuggestionConfidence(-1), 0);
  });

  it('hashes long external metadata cache keys into database-safe values', () => {
    const key = `ai:${'长路径和摘要'.repeat(100)}:deepseek-v4-flash`;
    const safe = safeCacheQueryKey(key);
    assert.ok(safe.length <= 180);
    assert.equal(safeCacheQueryKey(key), safe);
    assert.notEqual(safe, key);
  });
});

describe('metadata candidate mapping', () => {
  it('maps only selected non-empty candidate fields to suggestions', () => {
    const context = {
      work: {
        title: '旧标题',
        author: null,
        description: null,
        tags: '[]',
        seriesName: null,
        seriesIndex: null,
        publishedYear: null
      }
    } as any;
    const suggestions = candidateToSuggestions(context, {
      id: 'candidate-1',
      source: 'bangumi',
      title: '新标题',
      author: '',
      description: '简介',
      tags: ['漫画'],
      confidence: 0.82,
      raw: {}
    }, ['title', 'author', 'tags']);
    assert.deepEqual(suggestions.map((suggestion) => suggestion.field), ['title', 'tags']);
  });
});

describe('douban crawler parsing', () => {
  it('parses subject search data into book candidates', () => {
    const html = `
      <script>
        window.__DATA__ = {"items":[
          {"tpl_name":"search_simple","id":1,"title":"丛书","url":"https://book.douban.com/series/1"},
          {"tpl_name":"search_subject","id":4913064,"title":"活着","abstract":"余华 / 作家出版社 / 2012-8 / 28.00元","abstract_2":"","cover_url":"https://img.example/cover.jpg","url":"https://book.douban.com/subject/4913064/"}
        ]};
        window.__USER__ = {};
      </script>`;
    const candidates = parseDoubanSearchHtml(html, 0.78);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, '4913064');
    assert.equal(candidates[0].title, '活着');
    assert.equal(candidates[0].author, '余华');
    assert.equal(candidates[0].publisher, '作家出版社');
    assert.equal(candidates[0].publishedYear, 2012);
    assert.equal(candidates[0].coverUrl, 'https://img.example/cover.jpg');
  });

  it('treats the third search abstract part as publisher when a translator is present', () => {
    const html = `
      <script>
        window.__DATA__ = {"items":[
          {"tpl_name":"search_subject","id":3787195,"title":"黑暗坡食人树","abstract":"[日] 岛田庄司 / 陈涤 / 新星出版社 / 2009-7 / 32.00元","abstract_2":"","cover_url":"https://img.example/dark.jpg","url":"https://book.douban.com/subject/3787195/"}
        ]};
      </script>`;
    const candidates = parseDoubanSearchHtml(html, 0.78);
    assert.equal(candidates[0].author, '[日] 岛田庄司');
    assert.equal(candidates[0].publisher, '新星出版社');
    assert.equal(candidates[0].publishedYear, 2009);
    assert.equal(candidates[0].coverUrl, 'https://img.example/dark.jpg');
  });

  it('parses subject detail html into a metadata candidate', () => {
    const html = `
      <script type="application/ld+json">{
        "@context":"http://schema.org",
        "@type":"Book",
        "name":"活着",
        "author":[{"@type":"Person","name":"余华"}],
        "url":"https://book.douban.com/subject/4913064/",
        "isbn":"9787506365437"
      }</script>
      <meta property="og:image" content="https://img.example/large.jpg" />
      <div id="info">
        <span class="pl">出版社:</span> 作家出版社<br/>
        <span class="pl">出版年:</span> 2012-8<br/>
        <span class="pl">ISBN:</span> 9787506365437<br/>
      </div>
      <h2><span>内容简介</span></h2>
      <div class="indent" id="link-report"><div><div class="intro"><p>这是第一段。</p><p>这是第二段。</p></div></div></div>`;
    const candidate = parseDoubanSubjectHtml(html);
    assert.equal(candidate?.id, '4913064');
    assert.equal(candidate?.title, '活着');
    assert.equal(candidate?.author, '余华');
    assert.equal(candidate?.publisher, '作家出版社');
    assert.equal(candidate?.publishedYear, 2012);
    assert.equal(candidate?.coverUrl, 'https://img.example/large.jpg');
    assert.equal(candidate?.description, '这是第一段。\n这是第二段。');
    assert.deepEqual(candidate?.raw, {
      id: '4913064',
      url: 'https://book.douban.com/subject/4913064/',
      isbn: '9787506365437',
      pubdate: '2012-8',
      publisher: '作家出版社',
      coverUrl: 'https://img.example/large.jpg'
    });
  });
});

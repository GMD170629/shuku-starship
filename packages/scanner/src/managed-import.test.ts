import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { parseComicVolumeFromName, parseEpubMetadata } from './managed-import';

async function writeEpubFixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'shuku-epub-'));
  const filePath = join(dir, 'fixture.epub');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return { dir, filePath };
}

function opf(manifest: string, spine: string) {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>目录测试</dc:title>
    <dc:creator>测试作者</dc:creator>
  </metadata>
  <manifest>${manifest}</manifest>
  ${spine}
</package>`;
}

function xhtml(body: string) {
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title></title></head><body>${body}</body></html>`;
}

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

  it('parses monitored folder comic volumes from the local FX sample', () => {
    const root = '/Users/guyu/www/shuku-starship/books/[FX战士久留美]';
    assert.deepEqual(parseComicVolumeFromName(`${root}/FX戰士久留美 (1).zip`), {
      seriesName: 'FX戰士久留美',
      seriesIndex: 1,
      title: 'FX戰士久留美 (1)'
    });
    assert.deepEqual(parseComicVolumeFromName(`${root}/FX戰士久留美 (5).zip`), {
      seriesName: 'FX戰士久留美',
      seriesIndex: 5,
      title: 'FX戰士久留美 (5)'
    });
  });

  it('supports common volume markers', () => {
    assert.equal(parseComicVolumeFromName('作品（2）.zip')?.seriesIndex, 2);
    assert.equal(parseComicVolumeFromName('作品 第3卷.cbz')?.seriesIndex, 3);
    assert.equal(parseComicVolumeFromName('作品 Vol.4.zip')?.seriesIndex, 4);
    assert.equal(parseComicVolumeFromName('作品 v05.zip')?.seriesIndex, 5);
  });

  it('uses the parent folder as series for pure volume archive names', () => {
    const root = '/monitor/[炎頭×YahaKo×葉月翼] [野生的最终BOSS出现了！ 黑翼的霸王] [未完] [bili]';
    assert.deepEqual(parseComicVolumeFromName(`${root}/Vol.08.zip`, 'Vol.08.zip'), {
      seriesName: '[炎頭×YahaKo×葉月翼] [野生的最终BOSS出现了！ 黑翼的霸王] [未完] [bili]',
      seriesIndex: 8,
      title: '[炎頭×YahaKo×葉月翼] [野生的最终BOSS出现了！ 黑翼的霸王] [未完] [bili] (8)'
    });
    assert.equal(parseComicVolumeFromName(`${root}/v07.zip`, 'v07.zip')?.seriesIndex, 7);
    assert.equal(parseComicVolumeFromName(`${root}/第06卷.zip`, '第06卷.zip')?.seriesIndex, 6);
  });

  it('keeps sibling pure volume archives as separate volumes', () => {
    const root = '/monitor/星舰漫画';
    const volumes = ['Vol.06.zip', 'Vol.07.zip', 'Vol.08.zip'].map((name) => parseComicVolumeFromName(`${root}/${name}`, name));
    assert.deepEqual(volumes.map((volume) => volume?.seriesName), ['星舰漫画', '星舰漫画', '星舰漫画']);
    assert.deepEqual(volumes.map((volume) => volume?.seriesIndex), [6, 7, 8]);
  });

  it('does not assign a series to archives without a volume marker', () => {
    assert.equal(parseComicVolumeFromName('/books/comics/单本漫画.zip'), null);
  });

  it('does not invent a series for pure volume archives without a usable parent', () => {
    assert.equal(parseComicVolumeFromName('/books/comics/Vol.08.zip', 'Vol.08.zip'), null);
  });
});

describe('parseEpubMetadata', () => {
  it('uses EPUB2 NCX titles instead of synthetic chapter names', async () => {
    const fixture = await writeEpubFixture({
      'OEBPS/content.opf': opf(`
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="c1" href="Text/chapter01.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="Text/chapter02.xhtml" media-type="application/xhtml+xml"/>
      `, '<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>'),
      'OEBPS/toc.ncx': `<?xml version="1.0" encoding="UTF-8"?><ncx><navMap>
        <navPoint><navLabel><text>序幕 苏格兰</text></navLabel><content src="Text/chapter01.xhtml#start"/></navPoint>
        <navPoint><navLabel><text>食人树</text></navLabel><content src="Text/chapter02.xhtml"/></navPoint>
      </navMap></ncx>`,
      'OEBPS/Text/chapter01.xhtml': xhtml('<h1>不应优先使用</h1>'),
      'OEBPS/Text/chapter02.xhtml': xhtml('<h1>不应优先使用</h1>')
    });
    try {
      const result = await parseEpubMetadata(fixture.filePath);
      assert.deepEqual(result.chapters.map((chapter) => chapter.title), ['序幕 苏格兰', '食人树']);
      assert.equal(result.chapters[0].href, 'Text/chapter01.xhtml#start');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('uses EPUB3 nav titles when NCX is absent', async () => {
    const fixture = await writeEpubFixture({
      'OEBPS/content.opf': opf(`
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="chapters/one.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="chapters/two.xhtml" media-type="application/xhtml+xml"/>
      `, '<spine><itemref idref="c1"/><itemref idref="c2"/></spine>'),
      'OEBPS/nav.xhtml': xhtml('<nav epub:type="toc"><ol><li><a href="chapters/one.xhtml">屋顶上的尸体</a></li><li><a href="chapters/two.xhtml#p2">尾声 手记</a></li></ol></nav>'),
      'OEBPS/chapters/one.xhtml': xhtml('<h1>fallback one</h1>'),
      'OEBPS/chapters/two.xhtml': xhtml('<h1>fallback two</h1>')
    });
    try {
      const result = await parseEpubMetadata(fixture.filePath);
      assert.deepEqual(result.chapters.map((chapter) => chapter.title), ['屋顶上的尸体', '尾声 手记']);
      assert.equal(result.chapters[1].href, 'chapters/two.xhtml#p2');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('falls back to XHTML headings when the EPUB has no TOC', async () => {
    const fixture = await writeEpubFixture({
      'OEBPS/content.opf': opf(`
        <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
      `, '<spine><itemref idref="c1"/><itemref idref="c2"/></spine>'),
      'OEBPS/one.xhtml': xhtml('<h1>第一节</h1>'),
      'OEBPS/two.xhtml': xhtml('<h2>第二节</h2>')
    });
    try {
      const result = await parseEpubMetadata(fixture.filePath);
      assert.deepEqual(result.chapters.map((chapter) => chapter.title), ['第一节', '第二节']);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('falls back to numbered chapters when no titles are available', async () => {
    const fixture = await writeEpubFixture({
      'OEBPS/content.opf': opf(`
        <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
      `, '<spine><itemref idref="c1"/><itemref idref="c2"/></spine>'),
      'OEBPS/one.xhtml': xhtml('<p>content</p>'),
      'OEBPS/two.xhtml': xhtml('<p>content</p>')
    });
    try {
      const result = await parseEpubMetadata(fixture.filePath);
      assert.deepEqual(result.chapters.map((chapter) => chapter.title), ['第 1 章', '第 2 章']);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('matches the local 黑暗坡食人树 Kindle-like table of contents when present', async () => {
    const sample = '/Users/guyu/www/shuku-starship/books/ebook/黑暗坡食人树 (18)/黑暗坡食人树 - （日）岛田庄司.epub';
    try {
      await stat(sample);
    } catch {
      return;
    }
    const result = await parseEpubMetadata(sample);
    assert.equal(result.chapterCount, 26);
    assert.ok(result.chapters.some((chapter) => chapter.title === '序幕 苏格兰'));
    assert.ok(result.chapters.some((chapter) => chapter.title === '屋顶上的尸体'));
    assert.ok(result.chapters.some((chapter) => chapter.title === '食人树'));
    assert.ok(result.chapters.some((chapter) => chapter.title === '尾声 手记'));
  });
});

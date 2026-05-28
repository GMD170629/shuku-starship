import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import yauzl from 'yauzl';
import { prisma } from './prisma';

const MAX_EPUB_SIZE_BYTES = Number(process.env.EPUB_MAX_SIZE_BYTES ?? 200 * 1024 * 1024);
const MAX_ENTRIES = Number(process.env.EPUB_MAX_ENTRIES ?? 5000);
const DEFAULT_COVER = '/covers/default.svg';
const STORAGE_ROOT = process.env.STORAGE_ROOT ?? '/storage';

export interface ParsedEpubChapter { title: string; href: string; idref?: string; mediaType?: string; sortOrder: number; }
export interface ParsedEpubMetadata { title: string; author: string; authors: string[]; language?: string | null; identifier?: string | null; isbn?: string | null; publisher?: string | null; publishedAt?: string | null; description?: string | null; subjects?: string[]; rights?: string | null; coverPath?: string | null; coverMediaType?: string | null; chapterCount: number; chapters: ParsedEpubChapter[]; opfPath: string; rawMetadata: Record<string, any>; }
export interface ImportBookResult { bookId: string; title: string; chapterCount: number; coverUrl: string; importStatus: 'completed'|'failed'; }

function arr<T>(v: T | T[] | undefined): T[] { if (!v) return []; return Array.isArray(v) ? v : [v]; }
function textOf(v: any): string | null { if (!v) return null; if (typeof v === 'string') return v.trim() || null; if (typeof v['#text'] === 'string') return v['#text'].trim() || null; return null; }
function sanitizeDescription(v: string | null) { return v ? v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null; }
function extractIsbn(ids: string[]) { for (const i of ids) { const m = i.replace(/[^0-9Xx]/g,'').match(/(?:97[89])?[0-9]{9}[0-9Xx]/); if (m) return m[0].toUpperCase(); } return null; }

async function openZip(path: string): Promise<yauzl.ZipFile> { return new Promise((res, rej)=>yauzl.open(path,{lazyEntries:true,validateEntrySizes:true},(e,z)=>e||!z?rej(e??new Error('open zip failed')):res(z))); }
async function readZipText(epubPath: string, entryPath: string) {
  const buf = await readZipBinary(epubPath, entryPath);
  return buf.toString('utf8');
}
async function readZipBinary(epubPath: string, entryPath: string): Promise<Buffer> {
  const zip = await openZip(epubPath);
  const target = entryPath.replace(/\\/g,'/');
  return new Promise((resolveBuf,reject)=>{
    let count=0;
    zip.readEntry();
    zip.on('entry',(entry)=>{ count++; if (count>MAX_ENTRIES) return reject(new Error('EPUB 资源过多，疑似恶意压缩包')); if (entry.fileName===target) { zip.openReadStream(entry,(err,s)=>{ if(err||!s) return reject(err??new Error('读取条目失败')); const chunks:Buffer[]=[]; s.on('data',d=>chunks.push(Buffer.from(d))); s.on('end',()=>{zip.close();resolveBuf(Buffer.concat(chunks));}); s.on('error',reject); }); } else zip.readEntry();});
    zip.on('end',()=>reject(new Error(`EPUB 中不存在文件: ${entryPath}`))); zip.on('error',reject);
  });
}

export async function parseEpubMetadata(epubPath: string): Promise<ParsedEpubMetadata> {
  if (extname(epubPath).toLowerCase() !== '.epub') throw new Error('仅支持 .epub 文件');
  const st = await stat(epubPath); if (st.size > MAX_EPUB_SIZE_BYTES) throw new Error('EPUB 文件过大');
  await openZip(epubPath).then((z)=>z.close());
  const containerXml = await readZipText(epubPath, 'META-INF/container.xml');
  const opfPath = (/full-path="([^"]+)"/.exec(containerXml)?.[1]);
  if (!opfPath) throw new Error('container.xml 缺少 rootfile full-path');
  const opfXml = await readZipText(epubPath, opfPath);
  const textTag = (tag:string)=>Array.from(opfXml.matchAll(new RegExp(`<${tag}[^>]*>([\s\S]*?)</${tag}>`,'gi'))).map(m=>m[1].replace(/<[^>]+>/g,'').trim()).filter(Boolean);
  const attrsFromTag=(name:string)=>Array.from(opfXml.matchAll(new RegExp(`<${name}\b([^>]*)/?>(?:</${name}>)?`,'gi'))).map(m=>Object.fromEntries(Array.from(m[1].matchAll(/([\w:-]+)="([^"]*)"/g)).map(x=>[x[1],x[2]])));
  const metadata = { 'dc:title': textTag('dc:title'), 'dc:creator': textTag('dc:creator'), 'dc:identifier': textTag('dc:identifier'), 'dc:language': textTag('dc:language'), 'dc:publisher': textTag('dc:publisher'), 'dc:date': textTag('dc:date'), 'dc:description': textTag('dc:description'), 'dc:subject': textTag('dc:subject'), 'dc:rights': textTag('dc:rights'), meta: attrsFromTag('meta') };
  const manifestItems = attrsFromTag('item').map(v=>({ '@_id': v.id, '@_href': v.href, '@_media-type': v['media-type'], '@_properties': v.properties }));
  const spineRefs = attrsFromTag('itemref').map(v=>({ '@_idref': v.idref }));
  const titles = arr(metadata['dc:title']).map(textOf).filter(Boolean) as string[];
  const creators = arr(metadata['dc:creator']).map(textOf).filter(Boolean) as string[];
  const identifiers = arr(metadata['dc:identifier']).map(textOf).filter(Boolean) as string[];
  const title = titles[0] ?? basename(epubPath, '.epub');
  const authors = creators.length ? creators : ['未知作者'];
  const chapterMap = new Map(manifestItems.map((i:any)=>[i['@_id'], i]));
  const chapters: ParsedEpubChapter[] = spineRefs.map((r:any,idx:number)=>{ const item=chapterMap.get(r['@_idref']); return { title: `第 ${idx+1} 章`, href: item?.['@_href'] ?? '', idref:r['@_idref'], mediaType:item?.['@_media-type'], sortOrder: idx+1 };}).filter(c=>c.href);
  const metaItems=arr(metadata.meta);
  const epub2CoverId = metaItems.find((m:any)=>m?.['@_name']==='cover')?.['@_content'];
  const epub2Cover = manifestItems.find((i:any)=>i['@_id']===epub2CoverId);
  const epub3Cover = manifestItems.find((i:any)=>String(i?.['@_properties']??'').includes('cover-image'));
  const fallbackCover = manifestItems.find((i:any)=>/image/.test(String(i?.['@_media-type']??'')) && /(cover|front|folder|封面)/i.test(String(i?.['@_href']??'')));
  const cover = epub2Cover ?? epub3Cover ?? fallbackCover;
  return { title, author: authors[0], authors, language: textOf(arr(metadata['dc:language'])[0]), identifier: identifiers[0]??null, isbn: extractIsbn(identifiers), publisher: textOf(arr(metadata['dc:publisher'])[0]), publishedAt: textOf(arr(metadata['dc:date'])[0]), description: sanitizeDescription(textOf(arr(metadata['dc:description'])[0])), subjects: arr(metadata['dc:subject']).map(textOf).filter(Boolean) as string[], rights: textOf(arr(metadata['dc:rights'])[0]), coverPath: cover?.['@_href'] ?? null, coverMediaType: cover?.['@_media-type'] ?? null, chapterCount: chapters.length, chapters, opfPath, rawMetadata: metadata };
}

export async function extractEpubCover(epubPath: string, coverItemPath: string, outputPath: string) {
  const outputDir = dirname(outputPath); await mkdir(outputDir, { recursive: true });
  const data = await readZipBinary(epubPath, coverItemPath);
  await writeFile(outputPath, data);
}

export async function importEpubBook(filePath: string): Promise<ImportBookResult> {
  const metadata = await parseEpubMetadata(filePath);
  const fileStat = await stat(filePath);
  const book = await prisma.book.create({ data: { title: metadata.title, author: metadata.author, description: metadata.description, format: 'EPUB', tags: '[]', sourcePath: filePath, sourceHash: `manual-${Date.now()}-${Math.random()}`, sizeBytes: BigInt(fileStat.size), chapterCount: metadata.chapterCount, language: metadata.language, publisher: metadata.publisher, publishedAt: metadata.publishedAt, identifier: metadata.identifier, isbn: metadata.isbn, importStatus: 'PARSING' } });
  let coverUrl = DEFAULT_COVER;
  let extractedCoverPath: string | null = null;
  try {
    if (metadata.coverPath) {
      const opfDir = dirname(metadata.opfPath);
      const rel = normalize(join(opfDir, metadata.coverPath)).replace(/^\/+/, '');
      const ext = extname(metadata.coverPath) || '.jpg';
      const out = resolve(STORAGE_ROOT, 'books', book.id, `cover${ext}`);
      await extractEpubCover(filePath, rel, out);
      extractedCoverPath = out;
      coverUrl = `/storage/books/${book.id}/cover${ext}`;
      await prisma.book.update({ where: { id: book.id }, data: { coverPath: out, coverStatus: 'READY' } });
    }
    await prisma.$transaction([
      prisma.bookChapter.createMany({ data: metadata.chapters.map((c) => ({ bookId: book.id, title: c.title, href: c.href, mediaType: c.mediaType ?? null, sortOrder: c.sortOrder })) }),
      prisma.readingUnit.createMany({ data: metadata.chapters.map((c) => ({ bookId: book.id, unitType: 'chapter', title: c.title, href: c.href, filePath: null, mediaType: c.mediaType ?? null, sortOrder: c.sortOrder, metadataJson: JSON.stringify({ idref: c.idref }) })) }),
      ...(coverUrl !== DEFAULT_COVER && extractedCoverPath ? [prisma.bookAsset.create({ data: { bookId: book.id, assetType: 'cover', filePath: extractedCoverPath, url: coverUrl, mediaType: metadata.coverMediaType ?? null, sortOrder: 0 } })] : []),
      prisma.bookMetadata.create({ data: { bookId: book.id, source: 'epub_opf', rawJson: JSON.stringify(metadata.rawMetadata) } }),
      prisma.bookFile.create({ data: { bookId: book.id, path: filePath, kind: 'EPUB', mimeType: 'application/epub+zip', sortOrder: 0, sizeBytes: BigInt(fileStat.size), mtimeMs: BigInt(Math.trunc(fileStat.mtimeMs)), hashStatus: 'FAILED' } }),
      prisma.book.update({ where: { id: book.id }, data: { importStatus: 'COMPLETED' } })
    ]);
    return { bookId: book.id, title: metadata.title, chapterCount: metadata.chapterCount, coverUrl, importStatus: 'completed' };
  } catch (error) {
    if (extractedCoverPath) await unlink(extractedCoverPath).catch(()=>{});
    await prisma.book.update({ where: { id: book.id }, data: { importStatus: 'FAILED', importError: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

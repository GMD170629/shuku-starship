import { createHash } from 'node:crypto';
import { accessSync, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { LibraryEdition, LibraryFile, LibraryWork } from '@prisma/client';
import { prisma } from '@shuku/database';
import yauzl from 'yauzl';

type WorkWithEditions = LibraryWork & {
  editions: Array<LibraryEdition & { files: LibraryFile[] }>;
};
export type CoverSize = 'small' | 'medium' | 'large';

const coverWidths: Record<CoverSize, number> = {
  small: 160,
  medium: 320,
  large: 640
};

const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tif', '.tiff']);

function workspaceRoot() {
  if (process.env.STORAGE_ROOT) return resolve(process.env.STORAGE_ROOT);
  let current = process.cwd();
  while (current !== resolve(current, '..')) {
    try {
      accessSync(join(current, 'pnpm-workspace.yaml'));
      return join(current, 'storage');
    } catch {
      current = resolve(current, '..');
    }
  }
  return join(process.cwd(), 'storage');
}

function coverDirectory(workId: string) {
  return join(workspaceRoot(), 'covers', workId);
}

export function coverPathFor(workId: string, size: CoverSize) {
  const svgPath = join(coverDirectory(workId), `${size}.svg`);
  if (existsSync(svgPath)) return svgPath;
  return join(coverDirectory(workId), `${size}.webp`);
}

function coverOutputPathFor(workId: string, size: CoverSize, ext: 'webp' | 'svg') {
  return join(coverDirectory(workId), `${size}.${ext}`);
}

function stableGradient(seed: string) {
  const hash = createHash('sha256').update(seed).digest();
  const hueA = hash[0] % 360;
  const hueB = (hueA + 55 + (hash[1] % 90)) % 360;
  const hueC = (hueA + 190 + (hash[2] % 60)) % 360;
  return {
    a: `hsl(${hueA} 72% 25%)`,
    b: `hsl(${hueB} 68% 39%)`,
    c: `hsl(${hueC} 82% 58%)`
  };
}

function escapeXml(input: string) {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function linesFor(text: string, maxChars: number, maxLines: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  let rest = normalized;
  while (rest && lines.length < maxLines) {
    if (rest.length <= maxChars) {
      lines.push(rest);
      break;
    }
    const cut = rest.lastIndexOf(' ', maxChars);
    const index = cut > maxChars * 0.45 ? cut : maxChars;
    lines.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  return lines;
}

async function textCover(work: WorkWithEditions) {
  const gradient = stableGradient(work.id);
  const titleLines = linesFor(work.title, 14, 4);
  const firstFile = work.editions.flatMap((edition) => edition.files).sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const author = work.author ?? (firstFile ? basename(firstFile.path) : '未知作者');
  const titleSvg = titleLines
    .map((line, index) => `<text x="54" y="${240 + index * 58}" class="title">${escapeXml(line)}</text>`)
    .join('');
  const svg = `
    <svg width="900" height="1280" viewBox="0 0 900 1280" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${gradient.a}"/>
          <stop offset=".58" stop-color="${gradient.b}"/>
          <stop offset="1" stop-color="${gradient.c}"/>
        </linearGradient>
        <radialGradient id="r" cx=".25" cy=".15" r=".7">
          <stop offset="0" stop-color="rgba(255,255,255,.42)"/>
          <stop offset="1" stop-color="rgba(255,255,255,0)"/>
        </radialGradient>
        <style>
          .kicker{font:600 34px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:4px;fill:rgba(255,255,255,.72)}
          .title{font:800 58px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:white}
          .author{font:500 32px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:rgba(255,255,255,.78)}
        </style>
      </defs>
      <rect width="900" height="1280" fill="url(#g)"/>
      <rect width="900" height="1280" fill="url(#r)"/>
      <circle cx="820" cy="1130" r="230" fill="rgba(255,255,255,.13)"/>
      <circle cx="92" cy="104" r="46" fill="rgba(255,255,255,.24)"/>
      <text x="54" y="120" class="kicker">${escapeXml(work.workType)}</text>
      ${titleSvg}
      <text x="54" y="1140" class="author">${escapeXml(author)}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

async function pdfFirstPageCover(filePath: string) {
  const { createCanvas, DOMMatrix, ImageData, Path2D } = await import('@napi-rs/canvas');
  const globals = globalThis as Record<string, unknown>;
  globals.DOMMatrix ??= DOMMatrix;
  globals.ImageData ??= ImageData;
  globals.Path2D ??= Path2D;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(filePath));
  const pdf = await pdfjs.getDocument({ data, disableWorker: true } as object).promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, Math.max(1, 900 / baseViewport.width));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext('2d');
  await page.render({ canvasContext, viewport } as never).promise;
  await pdf.destroy();
  return canvas.toBuffer('image/png');
}

async function zipFirstImageCover(filePath: string) {
  const firstImage = await new Promise<string>((resolveImage, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('ZIP 打开失败'));
        return;
      }
      const images: string[] = [];
      const close = () => {
        try {
          zipFile.close();
        } catch {
          // yauzl may already have closed the descriptor.
        }
      };
      zipFile.on('entry', (entry) => {
        if (!/\/$/.test(entry.fileName) && imageExts.has(extname(entry.fileName).toLowerCase())) images.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.once('end', () => {
        close();
        images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const image = images[0];
        if (image) resolveImage(image);
        else reject(new Error('压缩包内没有可用图片'));
      });
      zipFile.once('error', (error) => {
        close();
        reject(error);
      });
      zipFile.readEntry();
    });
  });

  return new Promise<Buffer>((resolveBuffer, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('ZIP 打开失败'));
        return;
      }
      const close = () => {
        try {
          zipFile.close();
        } catch {
          // yauzl may already have closed the descriptor.
        }
      };
      const fail = (error: Error) => {
        close();
        reject(error);
      };
      zipFile.on('entry', (entry) => {
        if (entry.fileName !== firstImage) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error('ZIP 图片读取失败'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.once('end', () => {
            close();
            resolveBuffer(Buffer.concat(chunks));
          });
          stream.once('error', fail);
        });
      });
      zipFile.once('end', () => fail(new Error('ZIP 图片不存在')));
      zipFile.once('error', fail);
      zipFile.readEntry();
    });
  });
}

async function imageFileCover(filePath: string) {
  return readFile(filePath);
}

async function sourceCover(work: WorkWithEditions) {
  const sortedFiles = work.editions.flatMap((edition) => edition.files.map((file) => ({ ...file, editionFormat: edition.format }))).sort((a, b) => a.sortOrder - b.sortOrder);
  const firstFile = sortedFiles[0];
  const sourcePath = firstFile?.path;
  if (!sourcePath) throw new Error('作品没有可用源文件');
  const ext = extname(sourcePath).toLowerCase();

  if (work.workType === 'COMIC' && ['.cbz', '.zip'].includes(ext)) return zipFirstImageCover(sourcePath);
  if (work.workType === 'EPUB') return textCover(work);
  throw new Error(`不支持的封面来源：${work.workType}`);
}

export class CoverService {
  static coverPathFor(workId: string, size: CoverSize) {
    return coverPathFor(workId, size);
  }

  static async generateWorkCover(work: WorkWithEditions) {
    await prisma.libraryWork.update({ where: { id: work.id }, data: { coverStatus: 'PENDING' } });
    await mkdir(coverDirectory(work.id), { recursive: true });

    let input: Buffer;
    let status: 'READY' | 'FAILED' = 'READY';
    try {
      input = await sourceCover(work);
    } catch {
      input = await textCover(work);
      status = 'FAILED';
    }

    try {
      const { default: sharp } = await import('sharp');
      await Promise.all(
        (Object.keys(coverWidths) as CoverSize[]).map((size) =>
          sharp(input, { limitInputPixels: false })
            .resize({ width: coverWidths[size], withoutEnlargement: false })
            .webp({ quality: size === 'large' ? 84 : 80 })
            .toFile(coverOutputPathFor(work.id, size, 'webp'))
        )
      );
      await Promise.all((Object.keys(coverWidths) as CoverSize[]).map((size) => rm(coverOutputPathFor(work.id, size, 'svg'), { force: true })));

      await prisma.libraryWork.update({
        where: { id: work.id },
        data: {
          coverStatus: status,
          coverPath: coverPathFor(work.id, 'medium')
        }
      });
      return status;
    } catch {
      const fallback = await textCover(work);
      await Promise.all((Object.keys(coverWidths) as CoverSize[]).map((size) => writeFile(coverOutputPathFor(work.id, size, 'svg'), fallback)));
      await Promise.all((Object.keys(coverWidths) as CoverSize[]).map((size) => rm(coverOutputPathFor(work.id, size, 'webp'), { force: true })));
      await prisma.libraryWork.update({
        where: { id: work.id },
        data: {
          coverStatus: 'FAILED',
          coverPath: coverPathFor(work.id, 'medium')
        }
      });
      return 'FAILED';
    }
  }

  static async generateBookCover(work: WorkWithEditions) {
    return this.generateWorkCover(work);
  }

  static async ensureWorkCover(work: WorkWithEditions) {
    const medium = coverPathFor(work.id, 'medium');
    const existing = await stat(medium).catch(() => null);
    if (existing?.isFile()) return;
    await CoverService.generateWorkCover(work);
  }

  static async ensureBookCover(work: WorkWithEditions) {
    await this.ensureWorkCover(work);
  }
}

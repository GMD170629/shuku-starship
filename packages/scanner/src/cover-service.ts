import { createHash } from 'node:crypto';
import { accessSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { Book, BookFile } from '@prisma/client';
import { prisma } from '@shuku/database';
import JSZip from 'jszip';

type BookWithFiles = Book & { files: BookFile[] };
export type CoverSize = 'small' | 'medium' | 'large';

const coverWidths: Record<CoverSize, number> = {
  small: 160,
  medium: 320,
  large: 640
};

const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tif', '.tiff']);
const textExts = new Set(['.txt', '.md', '.markdown']);

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

function coverDirectory(bookId: string) {
  return join(workspaceRoot(), 'covers', bookId);
}

export function coverPathFor(bookId: string, size: CoverSize) {
  return join(coverDirectory(bookId), `${size}.webp`);
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

async function textCover(book: BookWithFiles) {
  const gradient = stableGradient(book.id);
  const titleLines = linesFor(book.title, 14, 4);
  const author = book.author ?? basename(book.sourcePath);
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
      <text x="54" y="120" class="kicker">${escapeXml(book.format)}</text>
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
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const firstImage = Object.values(zip.files)
    .filter((file) => !file.dir && imageExts.has(extname(file.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!firstImage) throw new Error('压缩包内没有可用图片');
  return firstImage.async('nodebuffer');
}

async function imageFileCover(filePath: string) {
  return readFile(filePath);
}

async function sourceCover(book: BookWithFiles) {
  const sortedFiles = [...book.files].sort((a, b) => a.sortOrder - b.sortOrder);
  const firstFile = sortedFiles[0];
  const sourcePath = firstFile?.path ?? book.sourcePath;
  const ext = extname(sourcePath).toLowerCase();

  if (book.format === 'PDF' || ext === '.pdf') return pdfFirstPageCover(sourcePath);
  if (book.format === 'COMIC' && ['.cbz', '.zip'].includes(ext)) return zipFirstImageCover(sourcePath);
  if (imageExts.has(ext)) return imageFileCover(sourcePath);
  if (book.format === 'TXT' || textExts.has(ext)) return textCover(book);
  throw new Error(`不支持的封面来源：${book.format}`);
}

export class CoverService {
  static coverPathFor(bookId: string, size: CoverSize) {
    return coverPathFor(bookId, size);
  }

  static async generateBookCover(book: BookWithFiles) {
    await prisma.book.update({ where: { id: book.id }, data: { coverStatus: 'PENDING' } });
    await mkdir(coverDirectory(book.id), { recursive: true });

    let input: Buffer;
    let status: 'READY' | 'FAILED' = 'READY';
    try {
      input = await sourceCover(book);
    } catch {
      input = await textCover(book);
      status = 'FAILED';
    }

    const { default: sharp } = await import('sharp');
    await Promise.all(
      (Object.keys(coverWidths) as CoverSize[]).map((size) =>
        sharp(input, { limitInputPixels: false })
          .resize({ width: coverWidths[size], withoutEnlargement: false })
          .webp({ quality: size === 'large' ? 84 : 80 })
          .toFile(coverPathFor(book.id, size))
      )
    );

    await prisma.book.update({
      where: { id: book.id },
      data: {
        coverStatus: status,
        coverPath: coverPathFor(book.id, 'medium')
      }
    });
    return status;
  }

  static async ensureBookCover(book: BookWithFiles) {
    const medium = coverPathFor(book.id, 'medium');
    const existing = await stat(medium).catch(() => null);
    if (existing?.isFile()) return;
    await CoverService.generateBookCover(book);
  }
}

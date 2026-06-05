import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Prisma, type DownloadTask } from '@prisma/client';
import { ensureDownloadInboxDir, getResolvedDownloadInboxPath } from '../download-tasks';
import { prisma } from '../prisma';

const allowedExtensions = new Set(['.epub', '.txt', '.pdf', '.cbz', '.zip', '.rar', '.7z']);
const blockedExtensions = new Set(['.exe', '.sh', '.bat', '.cmd', '.js', '.php', '.msi', '.com', '.scr', '.ps1', '.vbs']);
const maxRedirects = 5;
const requestTimeoutMs = 30000;

type RemoteRef = Record<string, unknown>;

function remoteRefObject(value: unknown): RemoteRef {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RemoteRef : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeFilename(value: string) {
  const base = path.basename(value)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(0, 180) || 'download';
}

function extensionOf(filename: string) {
  return path.extname(filename).toLocaleLowerCase();
}

function assertAllowedExtension(filename: string) {
  const ext = extensionOf(filename);
  if (!ext) throw new Error('下载文件缺少扩展名');
  if (blockedExtensions.has(ext) || !allowedExtensions.has(ext)) throw new Error(`不允许下载 ${ext.slice(1)} 文件`);
}

function filenameFromContentDisposition(header: string | null) {
  if (!header) return '';
  const utf8Match = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].replace(/^"|"$/g, '');
    }
  }
  const plainMatch = /filename\s*=\s*("?)([^";]+)\1/i.exec(header);
  return plainMatch ? plainMatch[2] : '';
}

function filenameFromUrl(value: string) {
  try {
    const url = new URL(value);
    return decodeURIComponent(path.basename(url.pathname));
  } catch {
    return '';
  }
}

async function uniqueInboxPath(filename: string) {
  ensureDownloadInboxDir();
  const inbox = getResolvedDownloadInboxPath();
  const parsed = path.parse(sanitizeFilename(filename));
  const ext = parsed.ext;
  const name = sanitizeFilename(parsed.name) || 'download';
  let candidate = path.join(inbox, `${name}${ext}`);
  let index = 1;
  while (true) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(`${inbox}${path.sep}`)) throw new Error('下载路径越界');
    try {
      await fs.access(resolved);
      candidate = path.join(inbox, `${name}-${index}${ext}`);
      index += 1;
    } catch {
      return resolved;
    }
  }
}

async function fetchWithRedirects(url: URL, redirectCount = 0): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只允许 http/https 下载地址');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: '*/*' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= maxRedirects) throw new Error('下载重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error(`下载重定向缺少 Location：HTTP ${response.status}`);
      return fetchWithRedirects(new URL(location, url), redirectCount + 1);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('下载请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function updateProgress(taskId: string, progress: number) {
  await prisma.downloadTask.update({
    where: { id: taskId },
    data: { progress: Math.max(1, Math.min(99, Math.round(progress))) }
  }).catch(() => undefined);
}

async function executeHttpDownload(task: DownloadTask) {
  const remoteRef = remoteRefObject(task.remoteRef);
  const downloadUrl = stringValue(remoteRef.downloadUrl);
  if (!downloadUrl) throw new Error('HTTP 下载任务缺少 remoteRef.downloadUrl');
  const url = new URL(downloadUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只允许 http/https 下载地址');

  const response = await fetchWithRedirects(url);
  if (!response.ok) throw new Error(`HTTP 下载失败：${response.status}`);
  if (!response.body) throw new Error('HTTP 响应没有可读取内容');

  const filename = sanitizeFilename(
    filenameFromContentDisposition(response.headers.get('content-disposition'))
      || stringValue(remoteRef.filename)
      || filenameFromUrl(response.url || downloadUrl)
      || task.displayName
  );
  assertAllowedExtension(filename);

  const targetPath = await uniqueInboxPath(filename);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  let downloaded = 0;
  let lastProgress = 0;
  const source = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    downloaded += chunk.length;
    if (contentLength > 0) {
      const progress = Math.floor((downloaded / contentLength) * 95);
      if (progress >= lastProgress + 5) {
        lastProgress = progress;
        void updateProgress(task.id, progress);
      }
    }
  });

  try {
    await pipeline(source, fsSync.createWriteStream(targetPath, { flags: 'wx' }));
    const stat = await fs.stat(targetPath);
    if (stat.size <= 0) throw new Error('下载文件为空');
    return targetPath;
  } catch (error) {
    await fs.rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function executeBlackhole(task: DownloadTask) {
  const filename = sanitizeFilename(`${task.displayName || task.id}.txt`);
  const targetPath = await uniqueInboxPath(filename);
  const note = [
    'Blackhole download placeholder',
    `Task: ${task.id}`,
    `Title: ${task.displayName}`,
    `Created: ${new Date().toISOString()}`,
    '',
    'This task type is a placeholder. No external BT client was invoked.'
  ].join('\n');
  await fs.writeFile(targetPath, note, { flag: 'wx' });
  return targetPath;
}

async function executeTelegramDownload(task: DownloadTask) {
  const remoteRef = remoteRefObject(task.remoteRef);
  if (stringValue(remoteRef.downloadUrl)) return executeHttpDownload(task);
  throw new Error('Z-Library Telegram Bot 下载需要 gateway 返回 downloadUrl，或先在 Telegram 中手动下载后导入。');
}

async function runTask(task: DownloadTask) {
  if (task.type === 'http') return executeHttpDownload(task);
  if (task.type === 'blackhole') return executeBlackhole(task);
  if (task.type === 'torrent') throw new Error('torrent 下载暂未支持：当前版本不会启动 BT 客户端');
  if (task.type === 'telegram') return executeTelegramDownload(task);
  throw new Error(`下载类型 ${task.type} 暂未支持`);
}

function errorSummary(error: unknown) {
  const message = error instanceof Error ? error.message : '下载执行失败';
  return message.slice(0, 500);
}

export async function executeDownloadTask(taskId: string): Promise<void> {
  const task = await prisma.downloadTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error('下载任务不存在');
  if (task.status !== 'queued' && task.status !== 'failed') return;

  await prisma.downloadTask.update({
    where: { id: task.id },
    data: { status: 'downloading', progress: 1, errorMessage: null }
  });

  try {
    const filePath = await runTask(task);
    await prisma.downloadTask.update({
      where: { id: task.id },
      data: {
        status: 'downloaded',
        progress: 100,
        filePath,
        savePath: getResolvedDownloadInboxPath(),
        errorMessage: null
      }
    });
  } catch (error) {
    await prisma.downloadTask.update({
      where: { id: task.id },
      data: {
        status: 'failed',
        errorMessage: errorSummary(error)
      }
    });
  }
}

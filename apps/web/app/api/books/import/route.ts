import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { importManagedBook } from '@shuku/scanner/managed-import';
import { requireUser } from '../../../../lib/auth';
import { fail, ok } from '../../../../lib/http';

export async function POST(request: Request) {
  await requireUser();
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return fail('请上传 EPUB、CBZ 或 ZIP 文件', 400);
  const ext = file.name.split('.').at(-1)?.toLowerCase();
  if (!ext || !['epub', 'cbz', 'zip'].includes(ext)) return fail('当前版本仅支持 EPUB、CBZ、ZIP 格式', 400);

  const tempRoot = join(process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage'), 'temp', 'uploads');
  await mkdir(tempRoot, { recursive: true });
  const tempPath = join(tempRoot, `${randomUUID()}.${ext}`);
  try {
    await writeFile(tempPath, Buffer.from(await file.arrayBuffer()));
    const result = await importManagedBook({ sourceFilePath: tempPath, originalName: file.name, origin: 'MANUAL' });
    return ok(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : '读物导入失败', 400);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

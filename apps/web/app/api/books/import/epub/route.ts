import { requireUser } from '../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../lib/http';
import { importEpubBook } from '../../../../../lib/epub-import';

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ filePath?: string }>(request);
  if (!body.filePath) return fail('缺少 filePath', 400);
  try {
    const result = await importEpubBook(body.filePath);
    return ok(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'EPUB 导入失败', 400);
  }
}

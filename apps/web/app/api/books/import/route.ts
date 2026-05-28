import { requireUser } from '../../../../lib/auth';
import { importBook } from '../../../../lib/book-import';
import { fail, ok, readJson } from '../../../../lib/http';

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ filePath?: string; originalName?: string; libraryPathId?: string }>(request);
  if (!body.filePath) return fail('缺少 filePath', 400);
  try {
    const result = await importBook({ filePath: body.filePath, originalName: body.originalName, libraryPathId: body.libraryPathId });
    return ok(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : '读物导入失败', 400);
  }
}

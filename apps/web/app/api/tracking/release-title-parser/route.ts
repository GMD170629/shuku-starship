import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { parseReleaseTitle } from '../../../../lib/tracking/release-title-parser';

export async function GET(request: Request) {
  await requireUser();
  const title = new URL(request.url).searchParams.get('title')?.trim();
  if (!title) return fail('请输入 title 参数', 400);
  return ok({ parsed: parseReleaseTitle(title) });
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ title?: string }>(request);
  const title = body.title?.trim();
  if (!title) return fail('请输入标题', 400);
  return ok({ parsed: parseReleaseTitle(title) });
}

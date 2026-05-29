import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { getAllReaderPreferenceSettings, getReaderPreferenceSettings, normalizeReaderPreferenceType, upsertReaderPreferenceSettings } from '../../../../lib/reader-preferences';

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const requestedReaderType = url.searchParams.get('readerType');
  if (!requestedReaderType) {
    return ok({ preferences: await getAllReaderPreferenceSettings(user.id) });
  }
  const readerType = normalizeReaderPreferenceType(requestedReaderType);
  if (!readerType) return fail('阅读器类型不正确', 400);
  return ok({ readerType: requestedReaderType, normalizedType: readerType, settings: await getReaderPreferenceSettings(user.id, readerType) });
}

export async function PUT(request: Request) {
  const user = await requireUser();
  const body = await readJson<{ readerType?: string; settings?: Record<string, unknown> }>(request);
  const readerType = normalizeReaderPreferenceType(body.readerType ?? 'ebook');
  if (!readerType) return fail('阅读器类型不正确', 400);
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
  return ok({ readerType, settings: await upsertReaderPreferenceSettings(user.id, readerType, settings) });
}

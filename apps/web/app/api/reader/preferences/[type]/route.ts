import { requireUser } from '../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../lib/http';
import { getReaderPreferenceSettings, normalizeReaderPreferenceType, upsertReaderPreferenceSettings } from '../../../../../lib/reader-preferences';

export async function GET(_request: Request, { params }: { params: { type: string } }) {
  const user = await requireUser();
  const readerType = normalizeReaderPreferenceType(params.type);
  if (!readerType) return fail('阅读器类型不正确', 400);
  return ok({ readerType, settings: await getReaderPreferenceSettings(user.id, readerType) });
}

export async function PUT(request: Request, { params }: { params: { type: string } }) {
  const user = await requireUser();
  const readerType = normalizeReaderPreferenceType(params.type);
  if (!readerType) return fail('阅读器类型不正确', 400);
  const body = await readJson<{ settings?: Record<string, unknown> } | Record<string, unknown>>(request);
  const candidate = 'settings' in body ? body.settings : body;
  const settings = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
  return ok({ readerType, settings: await upsertReaderPreferenceSettings(user.id, readerType, settings) });
}

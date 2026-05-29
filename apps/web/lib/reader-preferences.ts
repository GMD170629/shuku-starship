import { prisma } from './prisma';

export const normalizedReaderPreferenceTypes = ['global', 'ebook', 'comic', 'pdf'] as const;
export type NormalizedReaderPreferenceType = (typeof normalizedReaderPreferenceTypes)[number];

const aliases: Record<string, NormalizedReaderPreferenceType> = {
  global: 'global',
  ebook: 'ebook',
  epub: 'ebook',
  txt: 'ebook',
  comic: 'comic',
  pdf: 'pdf'
};

export function normalizeReaderPreferenceType(value: string | null | undefined) {
  if (!value) return null;
  return aliases[value.trim().toLowerCase()] ?? null;
}

export function safePreferenceJson(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function getReaderPreferenceSettings(userId: string, type: NormalizedReaderPreferenceType) {
  const preference = await prisma.readerPreference.findUnique({
    where: { userId_readerType: { userId, readerType: type } }
  });
  if (preference) return safePreferenceJson(preference.settings);

  if (type === 'ebook') {
    const legacyPreference = await prisma.readerPreference.findFirst({
      where: { userId, readerType: { in: ['epub', 'txt'] } },
      orderBy: { updatedAt: 'desc' }
    });
    return safePreferenceJson(legacyPreference?.settings);
  }

  return {};
}

export async function getAllReaderPreferenceSettings(userId: string) {
  const entries = await Promise.all(
    normalizedReaderPreferenceTypes.map(async (type) => [type, await getReaderPreferenceSettings(userId, type)] as const)
  );
  return Object.fromEntries(entries) as Record<NormalizedReaderPreferenceType, Record<string, unknown>>;
}

export async function upsertReaderPreferenceSettings(userId: string, type: NormalizedReaderPreferenceType, settings: Record<string, unknown>) {
  await prisma.readerPreference.upsert({
    where: { userId_readerType: { userId, readerType: type } },
    create: { userId, readerType: type, settings: JSON.stringify(settings) },
    update: { settings: JSON.stringify(settings) }
  });
  return settings;
}

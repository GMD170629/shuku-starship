import { access } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { parseEpubMetadata } from '@shuku/scanner/managed-import';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'mysql://shuku:shuku@localhost:3306/shuku_starship_test';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function firstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next likely storage root.
    }
  }
  return candidates[0];
}

async function resolveEpubPath(path: string) {
  if (isAbsolute(path)) return path;
  return firstExistingPath([
    resolve(process.cwd(), path),
    resolve(repoRoot, path),
    join(repoRoot, 'apps/web', path)
  ]);
}

async function backfillLibraryEditions() {
  const editions = await prisma.libraryEdition.findMany({
    where: { format: 'EPUB', hidden: false },
    include: {
      files: { where: { kind: 'EPUB' }, orderBy: { sortOrder: 'asc' } },
      volumes: { orderBy: { sortOrder: 'asc' } }
    },
    orderBy: { createdAt: 'asc' }
  });

  let updated = 0;
  for (const edition of editions) {
    const file = edition.files[0];
    if (!file) continue;
    const epubPath = await resolveEpubPath(file.path);
    const metadata = await parseEpubMetadata(epubPath);
    const volume = edition.volumes[0] ?? null;
    console.log(`${dryRun ? '[dry-run] ' : ''}edition ${edition.id}: ${metadata.chapters.length} chapters from ${epubPath}`);
    updated += 1;
    if (dryRun) continue;
    await prisma.$transaction([
      prisma.libraryReadingUnit.deleteMany({ where: { editionId: edition.id, unitType: 'chapter' } }),
      prisma.libraryReadingUnit.createMany({
        data: metadata.chapters.map((chapter) => ({
          editionId: edition.id,
          volumeId: volume?.id ?? null,
          fileId: file.id,
          unitType: 'chapter',
          title: chapter.title,
          href: chapter.href,
          mediaType: chapter.mediaType ?? null,
          sortOrder: chapter.sortOrder,
          metadataJson: JSON.stringify({ idref: chapter.idref })
        }))
      }),
      prisma.libraryEdition.update({ where: { id: edition.id }, data: { chapterCount: metadata.chapters.length } }),
      ...(volume ? [prisma.libraryVolume.update({ where: { id: volume.id }, data: { chapterCount: metadata.chapters.length } })] : [])
    ]);
  }
  return updated;
}

async function main() {
  const editionCount = await backfillLibraryEditions();
  console.log(`${dryRun ? 'dry run complete' : 'backfill complete'}: editions=${editionCount}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

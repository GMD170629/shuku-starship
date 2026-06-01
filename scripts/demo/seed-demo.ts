import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

if (process.env.DEMO_MODE !== 'true') {
  throw new Error('Demo seed requires DEMO_MODE=true');
}

const demoBooks = [
  { title: '星屑魔女与机械书库', author: 'Shuku Lab', format: 'COMIC' as const, file: '/demo/managed/star-dust.cbz', sizeBytes: 326 * 1024 * 1024 },
  { title: '星舰 EPUB 说明书', author: 'Archive Ops', format: 'EPUB' as const, file: '/demo/managed/starship.epub', sizeBytes: 18 * 1024 * 1024 }
];

async function main() {
  for (const book of demoBooks) {
    const contentHash = createHash('sha256').update(book.file).digest('hex');
    const work = await prisma.libraryWork.upsert({
      where: { mergeKey: `demo:${contentHash}` },
      create: {
        title: book.title,
        normalizedTitle: book.title.toLowerCase(),
        author: book.author,
        normalizedAuthor: book.author.toLowerCase(),
        workType: book.format,
        tags: JSON.stringify(['demo']),
        origin: 'MANUAL',
        coverStatus: 'FAILED',
        mergeKey: `demo:${contentHash}`
      },
      update: {}
    });
    const edition = await prisma.libraryEdition.upsert({
      where: { workId_versionKey: { workId: work.id, versionKey: `demo:${contentHash}` } },
      create: {
        workId: work.id,
        origin: 'MANUAL',
        format: book.format,
        versionName: 'Demo',
        versionKey: `demo:${contentHash}`,
        sizeBytes: BigInt(book.sizeBytes),
        coverStatus: 'FAILED',
        importStatus: 'COMPLETED',
        pageCount: book.format === 'COMIC' ? 1 : null,
        chapterCount: book.format === 'EPUB' ? 1 : null,
        primary: true
      },
      update: {}
    });
    await prisma.libraryFile.upsert({
      where: { path: book.file },
      create: {
        editionId: edition.id,
        path: book.file,
        filePathHash: contentHash,
        fingerprint: `demo:${contentHash}`,
        fullHash: contentHash,
        hashStatus: 'FULL',
        kind: book.format,
        mimeType: book.format === 'EPUB' ? 'application/epub+zip' : 'application/zip',
        sizeBytes: BigInt(book.sizeBytes)
      },
      update: {}
    });
    await prisma.libraryWork.update({ where: { id: work.id }, data: { primaryEditionId: edition.id } });
  }
  console.log(`demo seed complete: ${demoBooks.length} demo books`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

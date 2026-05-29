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
    await prisma.book.upsert({
      where: { contentHash },
      create: {
        title: book.title,
        author: book.author,
        format: book.format,
        tags: JSON.stringify(['demo']),
        managedFilePath: book.file,
        contentHash,
        sizeBytes: BigInt(book.sizeBytes),
        origin: 'MANUAL',
        coverStatus: 'FAILED',
        pageCount: book.format === 'COMIC' ? 1 : null,
        chapterCount: book.format === 'EPUB' ? 1 : null
      },
      update: {}
    });
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

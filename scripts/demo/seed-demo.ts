import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

if (process.env.DEMO_MODE !== 'true') {
  throw new Error('Demo seed requires DEMO_MODE=true');
}

const demoBooks = [
  { title: '星屑魔女与机械书库', author: 'Shuku Lab', format: 'COMIC' as const, sizeBytes: 326 * 1024 * 1024 },
  { title: 'NAS 书库维护手册', author: 'Archive Ops', format: 'PDF' as const, sizeBytes: 18 * 1024 * 1024 },
  { title: '阅读笔记合集', author: 'Gu', format: 'TXT' as const, sizeBytes: 128 * 1024 }
];

async function main() {
  const libraryPath = await prisma.libraryPath.upsert({
    where: { rootPath: '/demo/books' },
    create: { name: 'Demo 书库', rootPath: '/demo/books', enabled: false, description: '仅 DEMO_MODE=true 使用' },
    update: { enabled: false }
  });

  for (const book of demoBooks) {
    const sourcePath = `/demo/books/${book.title}`;
    await prisma.book.upsert({
      where: { sourceHash: createHash('sha256').update(sourcePath).digest('hex') },
      create: {
        libraryPathId: libraryPath.id,
        title: book.title,
        author: book.author,
        format: book.format,
        tags: JSON.stringify(['demo']),
        sourcePath,
        sourceHash: createHash('sha256').update(sourcePath).digest('hex'),
        sizeBytes: BigInt(book.sizeBytes),
        coverStatus: 'FAILED'
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

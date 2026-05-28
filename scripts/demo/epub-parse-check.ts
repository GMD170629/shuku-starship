import { parseEpubMetadata } from '../../apps/web/lib/epub-import';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: tsx scripts/demo/epub-parse-check.ts <file.epub>');
  const result = await parseEpubMetadata(file);
  console.log(JSON.stringify({ title: result.title, author: result.author, chapterCount: result.chapterCount }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

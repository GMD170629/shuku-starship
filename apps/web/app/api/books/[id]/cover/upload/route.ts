import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { requireUser } from '../../../../../../lib/auth';
import { fail, ok } from '../../../../../../lib/http';
import { prisma } from '../../../../../../lib/prisma';

const acceptedTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
]);

export async function POST(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const work = await prisma.libraryWork.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!work) return fail('读物不存在或无权访问', 404);

  const form = await request.formData().catch(() => null);
  const file = form?.get('cover');
  if (!(file instanceof File)) return fail('请上传 JPG、PNG 或 WebP 封面', 400);
  const ext = acceptedTypes.get(file.type) ?? extname(file.name).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return fail('封面格式仅支持 JPG、PNG、WebP', 400);
  if (file.size > 8 * 1024 * 1024) return fail('封面不能超过 8MB', 400);

  const storageRoot = process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage');
  const coverRoot = join(storageRoot, 'covers', 'custom');
  await mkdir(coverRoot, { recursive: true });
  const coverPath = join(coverRoot, `${params.id}${ext === '.jpeg' ? '.jpg' : ext}`);
  await writeFile(coverPath, Buffer.from(await file.arrayBuffer()));

  const updated = await prisma.libraryWork.update({
    where: { id: params.id },
    data: { coverPath, coverStatus: 'READY' }
  });

  return ok({ bookId: updated.id, coverUrl: `/api/books/${updated.id}/cover?size=medium&v=${Date.now()}` });
}

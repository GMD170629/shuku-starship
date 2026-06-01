import { requireUser } from '../../../../../../../lib/auth';
import { fail, ok, readJson } from '../../../../../../../lib/http';
import { prisma } from '../../../../../../../lib/prisma';

export async function POST(request: Request, { params }: { params: { id: string; volumeId: string } }) {
  await requireUser();
  const body = await readJson<{ direction?: 'up' | 'down'; sortOrder?: number; volumeIndex?: number | null }>(request);
  const volume = await prisma.libraryVolume.findFirst({
    where: { id: params.volumeId, edition: { workId: params.id } },
    include: { edition: { include: { volumes: { orderBy: { sortOrder: 'asc' } } } } }
  });
  if (!volume) return fail('卷册不存在', 404);
  let nextSortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : volume.sortOrder;
  if (body.direction) {
    const volumes = volume.edition.volumes;
    const index = volumes.findIndex((item) => item.id === volume.id);
    const swap = body.direction === 'up' ? volumes[index - 1] : volumes[index + 1];
    if (swap) {
      await prisma.$transaction([
        prisma.libraryVolume.update({ where: { id: volume.id }, data: { sortOrder: swap.sortOrder } }),
        prisma.libraryVolume.update({ where: { id: swap.id }, data: { sortOrder: volume.sortOrder } })
      ]);
      return ok({ moved: true });
    }
  }
  const updated = await prisma.libraryVolume.update({
    where: { id: volume.id },
    data: {
      sortOrder: nextSortOrder,
      volumeIndex: body.volumeIndex === undefined ? volume.volumeIndex : body.volumeIndex
    }
  });
  return ok({ volume: updated });
}

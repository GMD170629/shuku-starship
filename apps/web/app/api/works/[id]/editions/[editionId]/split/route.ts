import { requireUser } from '../../../../../../../lib/auth';
import { fail, ok } from '../../../../../../../lib/http';
import { prisma } from '../../../../../../../lib/prisma';

export async function POST(_request: Request, { params }: { params: { id: string; editionId: string } }) {
  await requireUser();
  const source = await prisma.libraryWork.findFirst({
    where: { id: params.id },
    include: { editions: { where: { id: params.editionId }, include: { volumes: true } } }
  });
  const edition = source?.editions[0];
  if (!source || !edition) return fail('版本不存在', 404);
  const newWork = await prisma.libraryWork.create({
    data: {
      monitorFolderId: source.monitorFolderId,
      origin: source.origin,
      title: `${source.title} - ${edition.versionName}`,
      normalizedTitle: `${source.normalizedTitle}${edition.id}`,
      author: source.author,
      normalizedAuthor: source.normalizedAuthor,
      description: edition.description ?? source.description,
      workType: edition.format,
      status: source.status,
      publicationStatus: source.publicationStatus,
      trackingStatus: source.trackingStatus,
      localLatestVolume: source.localLatestVolume,
      localLatestChapter: source.localLatestChapter,
      localLatestTitle: source.localLatestTitle,
      localLatestAt: source.localLatestAt,
      tags: source.tags,
      coverPath: edition.coverPath ?? source.coverPath,
      coverStatus: edition.coverPath || source.coverPath ? 'READY' : source.coverStatus,
      organized: false,
      primaryEditionId: edition.id,
      mergeKey: `${source.mergeKey ?? source.id}:split:${edition.id}`
    }
  });
  await prisma.$transaction([
    prisma.libraryEdition.update({ where: { id: edition.id }, data: { workId: newWork.id, primary: true } }),
    prisma.libraryReadingProgress.updateMany({ where: { editionId: edition.id }, data: { workId: newWork.id } }),
    prisma.importTask.updateMany({ where: { editionId: edition.id }, data: { workId: newWork.id } }),
    prisma.libraryEdition.updateMany({ where: { workId: source.id }, data: { primary: false } })
  ]);
  const remaining = await prisma.libraryEdition.findFirst({ where: { workId: source.id, hidden: false }, orderBy: { createdAt: 'asc' } });
  if (remaining) {
    await prisma.$transaction([
      prisma.libraryEdition.update({ where: { id: remaining.id }, data: { primary: true } }),
      prisma.libraryWork.update({ where: { id: source.id }, data: { primaryEditionId: remaining.id } })
    ]);
  }
  return ok({ workId: newWork.id, editionId: edition.id });
}

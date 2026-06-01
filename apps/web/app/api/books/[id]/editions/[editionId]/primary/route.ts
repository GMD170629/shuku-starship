import { requireUser } from '../../../../../../../lib/auth';
import { fail, ok } from '../../../../../../../lib/http';
import { prisma } from '../../../../../../../lib/prisma';

export async function POST(_request: Request, { params }: { params: { id: string; editionId: string } }) {
  await requireUser();
  const edition = await prisma.libraryEdition.findFirst({ where: { id: params.editionId, workId: params.id, hidden: false } });
  if (!edition) return fail('版本不存在', 404);
  await prisma.$transaction([
    prisma.libraryEdition.updateMany({ where: { workId: params.id }, data: { primary: false } }),
    prisma.libraryEdition.update({ where: { id: params.editionId }, data: { primary: true } }),
    prisma.libraryWork.update({
      where: { id: params.id },
      data: {
        primaryEditionId: params.editionId,
        coverPath: edition.coverPath ?? undefined,
        coverStatus: edition.coverPath ? 'READY' : undefined
      }
    })
  ]);
  return ok({ primaryEditionId: params.editionId });
}

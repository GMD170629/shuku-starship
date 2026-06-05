import type { Prisma } from '@prisma/client';
import { requireUser } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { toWorkView } from '../../../../lib/books';
import { prisma } from '../../../../lib/prisma';
import { normalizeTags, parsePublicationStatus, parseReadingStatus, parseTrackingStatus } from '../../../../lib/book-metadata';

function safeJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeUnit(unit: { size?: bigint | null; metadataJson?: string } & Record<string, unknown>) {
  return { ...unit, size: unit.size ? Number(unit.size) : null, metadataJson: unit.metadataJson ? safeJson(unit.metadataJson) : {} };
}

function parseNullableFloat(value: unknown) {
  if (value === null || value === '') return { ok: true as const, value: null };
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return { ok: false as const };
  return { ok: true as const, value: numberValue };
}

function parseNullableDate(value: unknown) {
  if (value === null || value === '') return { ok: true as const, value: null };
  if (typeof value !== 'string' && !(value instanceof Date)) return { ok: false as const };
  const dateValue = new Date(value);
  if (Number.isNaN(dateValue.getTime())) return { ok: false as const };
  return { ok: true as const, value: dateValue };
}

async function findWork(id: string, userId: string) {
  return prisma.libraryWork.findFirst({
    where: { id },
    include: {
      editions: {
        orderBy: [{ primary: 'desc' }, { createdAt: 'asc' }],
        include: {
          files: { orderBy: { sortOrder: 'asc' } },
          volumes: { orderBy: { sortOrder: 'asc' } },
          progresses: { where: { userId }, take: 1 },
          metadataItems: { orderBy: { createdAt: 'desc' } },
          readingUnits: { orderBy: { sortOrder: 'asc' } }
        }
      },
      progresses: { where: { userId }, take: 1 }
    }
  });
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const work = await findWork(params.id, user.id);
  if (!work) return fail('读物不存在或无权访问', 404);
  const view = toWorkView(work);
  const primaryEdition = work.editions.find((edition) => edition.id === view.editionId) ?? work.editions[0] ?? null;
  return ok({
    book: view,
    metadata: {
      language: primaryEdition?.language ?? null,
      publisher: primaryEdition?.publisher ?? null,
      publishedAt: primaryEdition?.publishedAt ?? null,
      identifier: primaryEdition?.identifier ?? null,
      isbn: primaryEdition?.isbn ?? null,
      importStatus: primaryEdition?.importStatus ?? null,
      importError: primaryEdition?.importError ?? null,
      items: (primaryEdition?.metadataItems ?? []).map((item) => ({ id: item.id, source: item.source, metadataJson: safeJson(item.rawJson), createdAt: item.createdAt }))
    },
    totalUnits: primaryEdition?.format === 'COMIC' ? (primaryEdition.pageCount ?? 0) : (primaryEdition?.chapterCount ?? 0),
    comicSections: view.volumes.filter((volume) => volume.editionId === primaryEdition?.id).map((volume) => ({
      id: volume.id,
      title: volume.title,
      index: volume.volumeIndex ?? volume.sortOrder,
      fileId: volume.id,
      pageCount: volume.pageCount ?? volume.chapterCount ?? 0,
      coverUrl: volume.coverUrl
    })),
    chapters: [],
    readingUnits: (primaryEdition?.readingUnits ?? []).map(serializeUnit)
  });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const body = await readJson<{
    title?: string;
    author?: string;
    description?: string;
    tags?: string[];
    status?: string;
    publicationStatus?: string;
    trackingStatus?: string;
    localLatestVolume?: number | string | null;
    localLatestChapter?: number | string | null;
    localLatestTitle?: string | null;
    localLatestAt?: string | null;
    ignored?: boolean;
    organized?: boolean;
    primaryEditionId?: string;
    seriesName?: string;
    seriesIndex?: number | string | null;
    publishedYear?: number | string | null;
  }>(request);
  const data: Prisma.LibraryWorkUpdateInput = {};
  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (!title) return fail('标题不能为空', 400);
    data.title = title;
    data.normalizedTitle = title.toLowerCase().replace(/[\s_\-.()[\]（）【】《》:：,，]+/g, '');
  }
  if (typeof body.author === 'string') {
    const author = body.author.trim();
    data.author = author || null;
    data.normalizedAuthor = author.toLowerCase().replace(/[\s_\-.()[\]（）【】《》:：,，]+/g, '') || null;
  }
  if (typeof body.description === 'string') data.description = body.description;
  if (typeof body.status === 'string') {
    const status = parseReadingStatus(body.status);
    if (!status) return fail('阅读状态不正确', 400);
    data.status = status;
  }
  if (typeof body.publicationStatus === 'string') {
    const publicationStatus = parsePublicationStatus(body.publicationStatus);
    if (!publicationStatus) return fail('出版状态不正确', 400);
    data.publicationStatus = publicationStatus;
  }
  if (typeof body.trackingStatus === 'string') {
    const trackingStatus = parseTrackingStatus(body.trackingStatus);
    if (!trackingStatus) return fail('追更状态不正确', 400);
    data.trackingStatus = trackingStatus;
  }
  if (body.localLatestVolume !== undefined) {
    const localLatestVolume = parseNullableFloat(body.localLatestVolume);
    if (!localLatestVolume.ok) return fail('本地最新卷号不正确', 400);
    data.localLatestVolume = localLatestVolume.value;
  }
  if (body.localLatestChapter !== undefined) {
    const localLatestChapter = parseNullableFloat(body.localLatestChapter);
    if (!localLatestChapter.ok) return fail('本地最新章/话不正确', 400);
    data.localLatestChapter = localLatestChapter.value;
  }
  if (body.localLatestTitle !== undefined) {
    data.localLatestTitle = typeof body.localLatestTitle === 'string' ? body.localLatestTitle.trim() || null : null;
  }
  if (body.localLatestAt !== undefined) {
    const localLatestAt = parseNullableDate(body.localLatestAt);
    if (!localLatestAt.ok) return fail('本地最新更新时间不正确', 400);
    data.localLatestAt = localLatestAt.value;
  }
  if (Array.isArray(body.tags)) data.tags = JSON.stringify(normalizeTags(body.tags));
  if (typeof body.ignored === 'boolean') data.hidden = body.ignored;
  if (typeof body.organized === 'boolean') {
    data.organized = body.organized;
    data.organizeStatus = body.organized ? 'APPLIED' : 'REVIEWING';
  }
  if (typeof body.seriesName === 'string') data.seriesName = body.seriesName.trim() || null;
  if (body.seriesIndex !== undefined) {
    const seriesIndex = body.seriesIndex === null || body.seriesIndex === '' ? null : Number(body.seriesIndex);
    if (seriesIndex !== null && !Number.isFinite(seriesIndex)) return fail('系列卷号不正确', 400);
    data.seriesIndex = seriesIndex;
  }
  if (body.publishedYear !== undefined) {
    const publishedYear = body.publishedYear === null || body.publishedYear === '' ? null : Number(body.publishedYear);
    if (publishedYear !== null && (!Number.isInteger(publishedYear) || publishedYear < 1000 || publishedYear > 3000)) return fail('出版年不正确', 400);
    data.publishedYear = publishedYear;
  }
  if (typeof body.primaryEditionId === 'string') {
    const edition = await prisma.libraryEdition.findFirst({ where: { id: body.primaryEditionId, workId: params.id } });
    if (!edition) return fail('版本不存在', 404);
    data.primaryEditionId = edition.id;
  }
  await prisma.libraryWork.update({ where: { id: params.id }, data });
  if (typeof body.primaryEditionId === 'string') {
    await prisma.$transaction([
      prisma.libraryEdition.updateMany({ where: { workId: params.id }, data: { primary: false } }),
      prisma.libraryEdition.update({ where: { id: body.primaryEditionId }, data: { primary: true } })
    ]);
  }
  const work = await findWork(params.id, user.id);
  if (!work) return fail('读物不存在或无权访问', 404);
  return ok({ book: toWorkView(work) });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const result = await prisma.libraryWork.deleteMany({ where: { id: params.id } });
  if (result.count === 0) return fail('读物不存在或无权访问', 404);
  return ok({ deleted: true, sourceFilesDeleted: false });
}

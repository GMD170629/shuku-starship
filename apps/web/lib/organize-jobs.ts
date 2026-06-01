import { createOrRefreshOrganizeJob } from '@shuku/scanner/organize-pipeline';
import type { DuplicateCandidate, MetadataSuggestion, OrganizeJob } from '@prisma/client';
import { toWorkView, type WorkWithLibrary } from './books';
import { duplicateBookIds, duplicateMatches, issueLabels, issuesForBook } from './organize';
import { prisma } from './prisma';

function safeJson(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function serializeSuggestion(suggestion: MetadataSuggestion) {
  return {
    id: suggestion.id,
    field: suggestion.field,
    currentValue: safeJson(suggestion.currentValue),
    suggestedValue: safeJson(suggestion.suggestedValue),
    source: suggestion.source,
    confidence: suggestion.confidence,
    reason: suggestion.reason,
    status: suggestion.status
  };
}

export function serializeDuplicate(duplicate: DuplicateCandidate) {
  return {
    id: duplicate.id,
    targetWorkId: duplicate.targetWorkId,
    reasons: safeJson(duplicate.reasons) ?? [],
    confidence: duplicate.confidence,
    suggestedAction: duplicate.suggestedAction,
    status: duplicate.status
  };
}

export async function ensureRecentOrganizeJobs() {
  const works = await prisma.libraryWork.findMany({
    where: {
      hidden: false,
      OR: [
        { organized: false },
        { organizeStatus: { in: ['PENDING', 'REVIEWING', 'FAILED'] } }
      ],
      organizeJobs: { none: { status: { in: ['PENDING', 'REVIEWING'] } } }
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, primaryEditionId: true }
  });
  await Promise.all(works.map((work) => createOrRefreshOrganizeJob({ workId: work.id, editionId: work.primaryEditionId }).catch(() => null)));
}

export async function listOrganizeJobs(userId: string, pageSize: number) {
  await ensureRecentOrganizeJobs();
  const jobs = await prisma.organizeJob.findMany({
    where: { status: { in: ['PENDING', 'REVIEWING', 'FAILED'] }, work: { hidden: false } },
    orderBy: { updatedAt: 'desc' },
    take: pageSize,
    include: {
      suggestions: { where: { status: 'PENDING' }, orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }] },
      duplicates: { where: { status: 'PENDING' }, orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }] },
      work: {
        include: {
          editions: {
            where: { hidden: false },
            orderBy: [{ primary: 'desc' }, { createdAt: 'asc' }],
            include: {
              files: { orderBy: { sortOrder: 'asc' } },
              volumes: { orderBy: { sortOrder: 'asc' } },
              progresses: { where: { userId }, take: 1 }
            }
          },
          progresses: { where: { userId }, take: 1 }
        }
      }
    }
  });

  return jobs.map((job) => ({
    id: job.id,
    status: job.status,
    issueCodes: safeJson(job.issueCodes) ?? [],
    summary: job.summary,
    errorSummary: job.errorSummary,
    updatedAt: job.updatedAt.toISOString(),
    book: toWorkView(job.work),
    suggestions: job.suggestions.map(serializeSuggestion),
    duplicates: job.duplicates.map(serializeDuplicate)
  }));
}

export async function pendingCompatibility(userId: string, pageSize: number) {
  const jobs = await listOrganizeJobs(userId, pageSize);
  const books = jobs.map((job) => job.book);
  const issues = Object.fromEntries(
    jobs.map((job) => [
      job.book.id,
      (job.issueCodes as string[]).map((code) => ({ code, label: issueLabels[code as keyof typeof issueLabels] ?? code.replace(/^SUGGEST_/, '建议补全 ') }))
    ])
  );
  const jobDuplicates = jobs.flatMap((job) =>
    job.duplicates.map((duplicate) => ({
      bookId: job.book.id,
      otherWorkId: duplicate.targetWorkId,
      reasons: (Array.isArray(duplicate.reasons) ? duplicate.reasons : []).map((reason) => ({ code: String(reason), label: String(reason) }))
    }))
  );
  if (jobDuplicates.length) return { books, issues, duplicates: jobDuplicates, total: books.length };

  const works = await prisma.libraryWork.findMany({
    where: { hidden: false },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      editions: { where: { hidden: false }, include: { files: true, volumes: true, progresses: { where: { userId }, take: 1 } } },
      progresses: { where: { userId }, take: 1 }
    }
  });
  const matches = duplicateMatches(works);
  const duplicateIds = duplicateBookIds(matches);
  const fallback = works
    .map((work) => ({ work, issues: issuesForBook(work as WorkWithLibrary, duplicateIds) }))
    .filter((item) => item.issues.length > 0)
    .slice(0, pageSize);
  return {
    books: fallback.map(({ work }) => toWorkView(work)),
    issues: Object.fromEntries(fallback.map(({ work, issues: codes }) => [work.id, codes.map((code) => ({ code, label: issueLabels[code] }))])),
    duplicates: matches.map((match) => ({
      ...match,
      reasons: match.reasons.map((reason) => ({ code: reason, label: reason === 'hash' ? '文件哈希相同' : reason === 'size' ? '文件大小相同' : '标题高度相似' }))
    })),
    total: fallback.length
  };
}

export type SerializedOrganizeJob = Awaited<ReturnType<typeof listOrganizeJobs>>[number];

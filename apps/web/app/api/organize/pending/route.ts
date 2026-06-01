import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { toWorkView } from '../../../../lib/books';
import { duplicateBookIds, duplicateMatches, issueLabels, issuesForBook } from '../../../../lib/organize';
import { prisma } from '../../../../lib/prisma';

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 60)));

  const works = await prisma.libraryWork.findMany({
    where: { hidden: false },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      editions: {
        where: { hidden: false },
        include: {
          files: { orderBy: { sortOrder: 'asc' } },
          volumes: { orderBy: { sortOrder: 'asc' } },
          progresses: { where: { userId: user.id }, take: 1 }
        }
      },
      progresses: { where: { userId: user.id }, take: 1 }
    }
  });

  const matches = duplicateMatches(works);
  const duplicateIds = duplicateBookIds(matches);
  const pending = works
    .map((work) => {
      const issues = issuesForBook(work, duplicateIds);
      return { work, issues };
    })
    .filter((item) => item.issues.length > 0)
    .slice(0, pageSize);

  const issueMap = Object.fromEntries(pending.map(({ work, issues }) => [work.id, issues.map((issue) => ({ code: issue, label: issueLabels[issue] }))]));
  const visibleIds = new Set(pending.map(({ work }) => work.id));
  const duplicateDetails = matches
    .filter((match) => visibleIds.has(match.workId) || visibleIds.has(match.otherWorkId))
    .map((match) => ({
      ...match,
      reasons: match.reasons.map((reason) => ({ code: reason, label: reason === 'hash' ? '文件哈希相同' : reason === 'size' ? '文件大小相同' : '标题高度相似' }))
    }));

  return ok({
    books: pending.map(({ work }) => toWorkView(work)),
    issues: issueMap,
    duplicates: duplicateDetails,
    total: pending.length
  } satisfies {
    books: ReturnType<typeof toWorkView>[];
    issues: Record<string, Array<{ code: string; label: string }>>;
    duplicates: Array<{ workId: string; otherWorkId: string; reasons: Array<{ code: string; label: string }> }>;
    total: number;
  });
}

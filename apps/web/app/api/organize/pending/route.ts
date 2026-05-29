import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { toBookView } from '../../../../lib/books';
import { duplicateBookIds, duplicateMatches, issueLabels, issuesForBook } from '../../../../lib/organize';
import { prisma } from '../../../../lib/prisma';

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 60)));

  const books = await prisma.book.findMany({
    where: { hidden: false },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      files: { orderBy: { sortOrder: 'asc' } },
      monitorFolder: true,
      progresses: { where: { userId: user.id }, take: 1 }
    }
  });

  const matches = duplicateMatches(books);
  const duplicateIds = duplicateBookIds(matches);
  const pending = books
    .map((book) => {
      const issues = issuesForBook(book, duplicateIds);
      return { book, issues };
    })
    .filter((item) => item.issues.length > 0)
    .slice(0, pageSize);

  const issueMap = Object.fromEntries(pending.map(({ book, issues }) => [book.id, issues.map((issue) => ({ code: issue, label: issueLabels[issue] }))]));
  const visibleIds = new Set(pending.map(({ book }) => book.id));
  const duplicateDetails = matches
    .filter((match) => visibleIds.has(match.bookId) || visibleIds.has(match.otherBookId))
    .map((match) => ({
      ...match,
      reasons: match.reasons.map((reason) => ({ code: reason, label: reason === 'hash' ? '文件哈希相同' : reason === 'size' ? '文件大小相同' : '标题高度相似' }))
    }));

  return ok({
    books: pending.map(({ book }) => toBookView(book)),
    issues: issueMap,
    duplicates: duplicateDetails,
    total: pending.length
  } satisfies {
    books: ReturnType<typeof toBookView>[];
    issues: Record<string, Array<{ code: string; label: string }>>;
    duplicates: Array<{ bookId: string; otherBookId: string; reasons: Array<{ code: string; label: string }> }>;
    total: number;
  });
}

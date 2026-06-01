import type { LibraryEdition, LibraryFile, LibraryWork } from '@prisma/client';

export type OrganizeIssueCode =
  | 'NEW_IMPORT'
  | 'MISSING_COVER'
  | 'MISSING_AUTHOR'
  | 'ODD_TITLE'
  | 'IMPORT_FAILED'
  | 'DUPLICATE';

export type DuplicateReason = 'hash' | 'size' | 'title';

export type DuplicateMatch = {
  workId: string;
  otherWorkId: string;
  reasons: DuplicateReason[];
};

export const issueLabels: Record<OrganizeIssueCode, string> = {
  NEW_IMPORT: '新导入',
  MISSING_COVER: '缺少封面',
  MISSING_AUTHOR: '缺少作者',
  ODD_TITLE: '标题异常',
  IMPORT_FAILED: '解析失败',
  DUPLICATE: '疑似重复'
};

export type WorkForOrganize = LibraryWork & {
  editions?: Array<LibraryEdition & { files?: LibraryFile[] }>;
};

export function normalizeTitleForCompare(title: string) {
  return title
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\s_\-.[\]()（）【】《》:：,，]+/g, '')
    .trim();
}

function titleLooksOdd(title: string) {
  const normalized = title.trim();
  if (normalized.length < 2) return true;
  if (/^[0-9a-f]{16,}$/i.test(normalized)) return true;
  if (/^(untitled|unknown|newbook|book)$/i.test(normalized)) return true;
  if (/\.(epub|cbz|zip|pdf|txt)$/i.test(normalized)) return true;
  return false;
}

export function duplicateMatches(works: WorkForOrganize[]) {
  const matches = new Map<string, Map<string, Set<DuplicateReason>>>();
  const addMatch = (a: string, b: string, reason: DuplicateReason) => {
    if (a === b) return;
    const first = a < b ? a : b;
    const second = a < b ? b : a;
    if (!matches.has(first)) matches.set(first, new Map());
    const pair = matches.get(first)!;
    if (!pair.has(second)) pair.set(second, new Set());
    pair.get(second)!.add(reason);
  };

  const byHash = new Map<string, WorkForOrganize[]>();
  const bySize = new Map<string, WorkForOrganize[]>();
  const byTitle = new Map<string, WorkForOrganize[]>();

  for (const work of works) {
    const files = (work.editions ?? []).flatMap((edition) => edition.files ?? []);
    const fullHash = files.find((file) => file.fullHash)?.fullHash;
    const sizeBytes = files.reduce((total, file) => total + BigInt(file.sizeBytes), BigInt(0));
    if (fullHash) byHash.set(fullHash, [...(byHash.get(fullHash) ?? []), work]);
    if (sizeBytes > BigInt(0)) bySize.set(String(sizeBytes), [...(bySize.get(String(sizeBytes)) ?? []), work]);
    const titleKey = normalizeTitleForCompare(work.title);
    if (titleKey.length >= 4) byTitle.set(titleKey, [...(byTitle.get(titleKey) ?? []), work]);
  }

  for (const group of byHash.values()) {
    if (group.length > 1) pairGroup(group, 'hash', addMatch);
  }
  for (const group of bySize.values()) {
    if (group.length > 1) pairGroup(group, 'size', addMatch);
  }
  for (const group of byTitle.values()) {
    if (group.length > 1) pairGroup(group, 'title', addMatch);
  }

  return [...matches.entries()].flatMap(([bookId, others]) =>
    [...others.entries()].map(([otherWorkId, reasons]) => ({ workId: bookId, otherWorkId, reasons: [...reasons] }))
  );
}

function pairGroup(group: WorkForOrganize[], reason: DuplicateReason, addMatch: (a: string, b: string, reason: DuplicateReason) => void) {
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) addMatch(group[i].id, group[j].id, reason);
  }
}

export function duplicateBookIds(matches: DuplicateMatch[]) {
  const ids = new Set<string>();
  for (const match of matches) {
    ids.add(match.workId);
    ids.add(match.otherWorkId);
  }
  return ids;
}

export function issuesForBook(book: WorkForOrganize, duplicateIds: Set<string>): OrganizeIssueCode[] {
  const issues: OrganizeIssueCode[] = [];
  if (!book.organized) issues.push('NEW_IMPORT');
  if (!book.coverPath || book.coverStatus !== 'READY') issues.push('MISSING_COVER');
  if (!book.author?.trim()) issues.push('MISSING_AUTHOR');
  if (titleLooksOdd(book.title)) issues.push('ODD_TITLE');
  if ((book.editions ?? []).some((edition) => edition.importStatus === 'FAILED' || edition.importError)) issues.push('IMPORT_FAILED');
  if (duplicateIds.has(book.id)) issues.push('DUPLICATE');
  return [...new Set(issues)];
}

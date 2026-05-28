type MergeBookFile = {
  id: string;
  path: string;
  sizeBytes: bigint | number;
  sortOrder: number;
};

type MergeBook = {
  id: string;
  pageCount: number | null;
  chapterCount: number | null;
  files: MergeBookFile[];
};

type MergeTransaction = {
  book: {
    findUnique(args: {
      where: { id: string };
      include: { files: { orderBy: { sortOrder: 'asc' } } };
    }): Promise<MergeBook | null>;
    update(args: {
      where: { id: string };
      data: {
        hidden?: boolean;
        sizeBytes?: bigint;
        pageCount?: number | null;
        chapterCount?: number | null;
      };
    }): Promise<unknown>;
  };
  bookFile: {
    update(args: { where: { id: string }; data: { bookId: string; sortOrder: number } }): Promise<unknown>;
  };
};

export type MergeDatabase = {
  $transaction<T>(handler: (tx: MergeTransaction) => Promise<T>): Promise<T>;
};

export class MergeBookError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

function addOptionalCounts(first: number | null, second: number | null) {
  if (first === null && second === null) return null;
  return (first ?? 0) + (second ?? 0);
}

export async function mergeBookFiles(db: MergeDatabase, targetBookId: string, sourceBookId: string) {
  if (!sourceBookId) throw new MergeBookError('请选择要合并的来源读物', 400);
  if (targetBookId === sourceBookId) throw new MergeBookError('不能合并同一本读物', 400);

  return db.$transaction(async (tx) => {
    const [target, source] = await Promise.all([
      tx.book.findUnique({
        where: { id: targetBookId },
        include: { files: { orderBy: { sortOrder: 'asc' } } }
      }),
      tx.book.findUnique({
        where: { id: sourceBookId },
        include: { files: { orderBy: { sortOrder: 'asc' } } }
      })
    ]);

    if (!target) throw new MergeBookError('目标读物不存在', 404);
    if (!source) throw new MergeBookError('来源读物不存在', 404);
    if (source.files.length === 0) throw new MergeBookError('来源读物没有可合并的文件', 400);

    const targetPaths = new Set(target.files.map((file) => file.path));
    const duplicatePath = source.files.find((file) => targetPaths.has(file.path));
    if (duplicatePath) throw new MergeBookError(`存在同名文件，无法合并分卷：${duplicatePath.path}`, 409);

    const maxSortOrder = target.files.reduce((max, file) => Math.max(max, file.sortOrder), -1);
    await Promise.all(
      source.files.map((file, index) =>
        tx.bookFile.update({
          where: { id: file.id },
          data: { bookId: target.id, sortOrder: maxSortOrder + index + 1 }
        })
      )
    );

    const sizeBytes = [...target.files, ...source.files].reduce((total, file) => total + BigInt(file.sizeBytes), BigInt(0));
    await tx.book.update({
      where: { id: target.id },
      data: {
        sizeBytes,
        pageCount: addOptionalCounts(target.pageCount, source.pageCount),
        chapterCount: addOptionalCounts(target.chapterCount, source.chapterCount)
      }
    });
    await tx.book.update({ where: { id: source.id }, data: { hidden: true } });

    return { mergedBookId: source.id };
  });
}

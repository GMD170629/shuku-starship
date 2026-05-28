import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeBookFiles, MergeBookError, type MergeDatabase } from './book-merge';

type TestFile = {
  id: string;
  path: string;
  sizeBytes: bigint;
  sortOrder: number;
};

type TestBook = {
  id: string;
  hidden: boolean;
  sizeBytes: bigint;
  pageCount: number | null;
  chapterCount: number | null;
  files: TestFile[];
};

function createDb(seed: TestBook[]) {
  const books = new Map(seed.map((book) => [book.id, structuredClone(book)]));
  const db: MergeDatabase = {
    async $transaction(handler) {
      return handler({
        book: {
          async findUnique(args) {
            const book = books.get(args.where.id);
            return book ? structuredClone(book) : null;
          },
          async update(args) {
            const book = books.get(args.where.id);
            if (!book) throw new Error('missing book');
            Object.assign(book, args.data);
            return structuredClone(book);
          }
        },
        bookFile: {
          async update(args) {
            for (const book of books.values()) {
              const index = book.files.findIndex((file) => file.id === args.where.id);
              if (index === -1) continue;
              const [file] = book.files.splice(index, 1);
              const target = books.get(args.data.bookId);
              if (!target) throw new Error('missing target book');
              target.files.push({ ...file, sortOrder: args.data.sortOrder });
              return file;
            }
            throw new Error('missing file');
          }
        }
      });
    }
  };

  return { db, books };
}

describe('mergeBookFiles', () => {
  it('moves source files after target files and hides the source book', async () => {
    const { db, books } = createDb([
      {
        id: 'target',
        hidden: false,
        sizeBytes: BigInt(10),
        pageCount: 2,
        chapterCount: null,
        files: [{ id: 'target-file', path: '/target.epub', sizeBytes: BigInt(10), sortOrder: 2 }]
      },
      {
        id: 'source',
        hidden: false,
        sizeBytes: BigInt(20),
        pageCount: 3,
        chapterCount: 4,
        files: [
          { id: 'source-file-1', path: '/source-1.epub', sizeBytes: BigInt(8), sortOrder: 0 },
          { id: 'source-file-2', path: '/source-2.epub', sizeBytes: BigInt(12), sortOrder: 1 }
        ]
      }
    ]);

    const result = await mergeBookFiles(db, 'target', 'source');

    assert.deepEqual(result, { mergedBookId: 'source' });
    assert.equal(books.get('source')?.hidden, true);
    assert.equal(books.get('target')?.sizeBytes, BigInt(30));
    assert.equal(books.get('target')?.pageCount, 5);
    assert.equal(books.get('target')?.chapterCount, 4);
    assert.deepEqual(
      books.get('target')?.files.map((file) => ({ id: file.id, sortOrder: file.sortOrder })),
      [
        { id: 'target-file', sortOrder: 2 },
        { id: 'source-file-1', sortOrder: 3 },
        { id: 'source-file-2', sortOrder: 4 }
      ]
    );
  });

  it('rejects merging a book into itself', async () => {
    const { db } = createDb([]);
    await assert.rejects(() => mergeBookFiles(db, 'same', 'same'), (error) => {
      assert.ok(error instanceof MergeBookError);
      assert.equal(error.status, 400);
      return true;
    });
  });

  it('rejects a missing source book', async () => {
    const { db } = createDb([
      { id: 'target', hidden: false, sizeBytes: BigInt(0), pageCount: null, chapterCount: null, files: [] }
    ]);

    await assert.rejects(() => mergeBookFiles(db, 'target', 'missing'), (error) => {
      assert.ok(error instanceof MergeBookError);
      assert.equal(error.status, 404);
      assert.equal(error.message, '来源读物不存在');
      return true;
    });
  });

  it('rejects duplicate file paths before moving files', async () => {
    const { db, books } = createDb([
      {
        id: 'target',
        hidden: false,
        sizeBytes: BigInt(1),
        pageCount: null,
        chapterCount: null,
        files: [{ id: 'target-file', path: '/same.epub', sizeBytes: BigInt(1), sortOrder: 0 }]
      },
      {
        id: 'source',
        hidden: false,
        sizeBytes: BigInt(1),
        pageCount: null,
        chapterCount: null,
        files: [{ id: 'source-file', path: '/same.epub', sizeBytes: BigInt(1), sortOrder: 0 }]
      }
    ]);

    await assert.rejects(() => mergeBookFiles(db, 'target', 'source'), (error) => {
      assert.ok(error instanceof MergeBookError);
      assert.equal(error.status, 409);
      return true;
    });
    assert.equal(books.get('source')?.hidden, false);
    assert.deepEqual(books.get('target')?.files.map((file) => file.id), ['target-file']);
  });
});

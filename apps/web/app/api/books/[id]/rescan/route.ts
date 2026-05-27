import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { prisma } from '../../../../../lib/prisma';

function createQueue() {
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    lazyConnect: true
  });
  return {
    queue: new Queue('scan-jobs', { connection: connection as never }),
    connection
  };
}

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const book = await prisma.book.findUnique({
    where: { id: params.id },
    include: { libraryPath: true }
  });
  if (!book) return fail('读物不存在或无权访问', 404);
  if (!book.libraryPathId || !book.libraryPath) return fail('读物没有关联的书库路径，无法重新扫描', 400);
  if (!book.libraryPath.enabled) return fail('所属书库路径已禁用，无法重新扫描', 400);

  const existing = await prisma.scanTask.findFirst({
    where: { libraryPathId: book.libraryPathId, status: { in: ['QUEUED', 'RUNNING'] } }
  });
  if (existing) return fail('该路径已有排队或运行中的扫描任务', 409, { scanTaskId: existing.id });

  const task = await prisma.scanTask.create({
    data: {
      libraryPathId: book.libraryPathId,
      status: 'QUEUED',
      mode: 'NORMAL',
      message: `等待 Worker 重新扫描：${book.sourcePath}`
    }
  });

  const { queue, connection } = createQueue();
  try {
    await queue.add(
      'scan-library-path',
      { scanTaskId: task.id, libraryPathId: book.libraryPathId, failedPaths: [book.sourcePath] },
      { removeOnComplete: 100, attempts: 1 }
    );
  } catch (error) {
    await prisma.scanTask.update({
      where: { id: task.id },
      data: { status: 'FAILED', message: '无法连接 Redis 或创建队列任务', errorCount: 1, errorSummary: String(error), finishedAt: new Date() }
    });
    return fail('无法连接 Worker 队列，请检查 Redis', 503, String(error));
  } finally {
    await queue.close();
    connection.disconnect();
  }

  return ok({ task }, { status: 201 });
}

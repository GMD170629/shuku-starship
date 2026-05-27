import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { requireUser } from '../../../lib/auth';
import { fail, ok, readJson } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

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

export async function GET() {
  await requireUser();
  const tasks = await prisma.scanTask.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { libraryPath: true, logs: { orderBy: { createdAt: 'desc' }, take: 20 } }
  });
  return ok({ tasks });
}

function parseErrorPath(message: string) {
  const match = /^(?:would error|error): (.*?): /.exec(message);
  return match?.[1];
}

export async function POST(request: Request) {
  await requireUser();
  const body = await readJson<{ libraryPathId?: string; dryRun?: boolean; retryFailedTaskId?: string }>(request);
  let retryFailedPaths: string[] = [];
  let retrySourceTaskId: string | undefined;

  if (body.retryFailedTaskId) {
    const sourceTask = await prisma.scanTask.findUnique({
      where: { id: body.retryFailedTaskId },
      include: { libraryPath: true }
    });
    if (!sourceTask) return fail('原扫描任务不存在', 404);
    body.libraryPathId = sourceTask.libraryPathId;
    retrySourceTaskId = sourceTask.id;
    const errorLogs = await prisma.scanLog.findMany({
      where: { scanTaskId: sourceTask.id, level: 'error' },
      orderBy: { createdAt: 'asc' },
      take: 1000
    });
    retryFailedPaths = [...new Set(errorLogs.map((line) => parseErrorPath(line.message)).filter((path): path is string => Boolean(path)))];
    if (retryFailedPaths.length === 0) return fail('该任务没有可重新扫描的失败文件', 400);
  }

  if (!body.libraryPathId) return fail('请选择要扫描的书库路径', 400);
  const libraryPath = await prisma.libraryPath.findUnique({ where: { id: body.libraryPathId } });
  if (!libraryPath) return fail('书库路径不存在', 404);
  if (!libraryPath.enabled) return fail('禁用的书库路径不能扫描', 400);

  const existing = await prisma.scanTask.findFirst({
    where: { libraryPathId: libraryPath.id, status: { in: ['QUEUED', 'RUNNING'] } }
  });
  if (existing) return fail('该路径已有排队或运行中的扫描任务', 409, { scanTaskId: existing.id });

  const task = await prisma.scanTask.create({
    data: {
      libraryPathId: libraryPath.id,
      status: 'QUEUED',
      mode: body.dryRun ? 'DRY_RUN' : 'NORMAL',
      message: retrySourceTaskId ? `等待 Worker 重新扫描 ${retryFailedPaths.length} 个失败文件` : body.dryRun ? 'Dry run 等待 Worker 消费' : '等待 Worker 消费'
    }
  });
  const { queue, connection } = createQueue();
  try {
    await queue.add(
      'scan-library-path',
      { scanTaskId: task.id, libraryPathId: libraryPath.id, failedPaths: retryFailedPaths },
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

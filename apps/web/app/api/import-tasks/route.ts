import { requireUser } from '../../../lib/auth';
import { ok } from '../../../lib/http';
import { prisma } from '../../../lib/prisma';

export async function GET() {
  await requireUser();
  const tasks = await prisma.importTask.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      monitorFolder: true,
      book: { select: { id: true, title: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 20 }
    }
  });
  const summary = {
    added: tasks.filter((task) => task.status === 'COMPLETED' && !task.duplicate).length,
    updated: 0,
    skipped: tasks.filter((task) => task.duplicate).length,
    failed: tasks.filter((task) => task.status === 'FAILED').length
  };
  return ok({ tasks: tasks.map(serializeTask), summary });
}

function serializeTask<T extends { sourcePath: string; managedFilePath: string | null; errorSummary: string | null }>(task: T) {
  const sourceName = task.sourcePath.split(/[\\/]/).filter(Boolean).at(-1) ?? task.sourcePath;
  const managedName = task.managedFilePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  return {
    ...task,
    sourcePath: sourceName,
    managedFilePath: managedName,
    friendlyError: friendlyError(task.errorSummary)
  };
}

function friendlyError(message: string | null) {
  const text = message ?? '';
  if (/EACCES|permission|权限/i.test(text)) return '权限不足：请确认容器用户可以读取该目录和文件。';
  if (/ENOENT|not found|不存在/i.test(text)) return '文件不存在：可能已被移动、删除，或监控目录配置已变化。';
  if (/unsupported|format|格式/i.test(text)) return '格式暂不支持：请确认文件是 EPUB、CBZ 或 ZIP。';
  if (/zip|archive|corrupt|invalid|损坏/i.test(text)) return '压缩包可能损坏：请重新复制文件或用本地工具测试压缩包。';
  return text ? '导入失败：请检查文件完整性和格式。' : null;
}

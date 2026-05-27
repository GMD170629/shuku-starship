import { requireUser } from '../../../../../lib/auth';
import { BackupService } from '../../../../../lib/backup-service';
import { fail, ok, readJson } from '../../../../../lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  const body = await readJson<{ confirm?: boolean; confirmText?: string }>(request);
  if (body.confirm !== true || body.confirmText !== 'RESTORE') {
    return fail('恢复备份需要二次确认', 400);
  }

  try {
    const restore = await BackupService.restoreBackup(params.id);
    return ok({ restore });
  } catch (error) {
    console.error('[backup-restore-error]', error);
    return fail(error instanceof Error ? error.message : '恢复备份失败', 500);
  }
}

import { requireUser } from '../../../../lib/auth';
import { BackupService } from '../../../../lib/backup-service';
import { fail, ok } from '../../../../lib/http';

export const runtime = 'nodejs';

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  try {
    await BackupService.deleteBackup(params.id);
    return ok({ deleted: true });
  } catch (error) {
    console.error('[backup-delete-error]', error);
    return fail('删除备份失败', 500);
  }
}

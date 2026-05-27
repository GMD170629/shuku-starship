import { requireUser } from '../../../lib/auth';
import { BackupService } from '../../../lib/backup-service';
import { fail, ok } from '../../../lib/http';

export const runtime = 'nodejs';

BackupService.startAutomaticScheduler();

export async function GET() {
  await requireUser();
  await BackupService.ensureAutomaticBackup();
  const backups = await BackupService.listBackups();
  return ok({ backups });
}

export async function POST() {
  await requireUser();
  try {
    const backup = await BackupService.createBackup('manual');
    return ok({ backup }, { status: 201 });
  } catch (error) {
    console.error('[backup-create-error]', error);
    return fail('创建备份失败', 500);
  }
}

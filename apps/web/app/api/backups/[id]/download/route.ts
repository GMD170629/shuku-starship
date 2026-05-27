import { requireUser } from '../../../../../lib/auth';
import { BackupService } from '../../../../../lib/backup-service';
import { fail } from '../../../../../lib/http';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await requireUser();
  try {
    const download = await BackupService.createDownloadStream(params.id);
    return new Response(download.stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(download.sizeBytes),
        'Content-Disposition': `attachment; filename="${download.filename}"`,
        'Cache-Control': 'private, no-store'
      }
    });
  } catch (error) {
    console.error('[backup-download-error]', error);
    return fail('备份文件不存在', 404);
  }
}

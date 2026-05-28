import { NextResponse } from 'next/server';
import { BackupService } from '../../../lib/backup-service';
import { runSystemHealthChecks } from '../../../lib/system-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

BackupService.startAutomaticScheduler();

export async function GET() {
  const health = await runSystemHealthChecks();
  return NextResponse.json({ service: 'shuku-starship', ...health }, { status: health.status === 'ok' ? 200 : 503 });
}

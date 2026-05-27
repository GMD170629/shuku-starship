import { NextResponse } from 'next/server';
import { BackupService } from '../../../lib/backup-service';

export const runtime = 'nodejs';

BackupService.startAutomaticScheduler();

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'shuku-starship'
  });
}

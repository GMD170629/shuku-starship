import { ok } from '../../../../lib/http';
import { runSystemHealthChecks } from '../../../../lib/system-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const health = await runSystemHealthChecks();
  return ok(health, { status: health.status === 'ok' ? 200 : 503 });
}

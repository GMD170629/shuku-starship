import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

const RESCAN_REQUESTED_AT_KEY = 'monitor.rescanRequestedAt';

export async function POST() {
  await requireUser();
  const requestedAt = new Date().toISOString();
  await prisma.systemSetting.upsert({
    where: { key: RESCAN_REQUESTED_AT_KEY },
    create: { key: RESCAN_REQUESTED_AT_KEY, value: requestedAt },
    update: { value: requestedAt }
  });
  return ok({ requestedAt });
}

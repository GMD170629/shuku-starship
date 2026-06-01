import { requireUser } from '../../../../../lib/auth';
import { fail, ok } from '../../../../../lib/http';
import { getOrganizeJob } from '../../../../../lib/organize-jobs';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const job = await getOrganizeJob(user.id, params.id);
  if (!job) return fail('整理任务不存在', 404);
  return ok({ job });
}

import { requireUser } from '../../../../lib/auth';
import { ok } from '../../../../lib/http';
import { listOrganizeJobs } from '../../../../lib/organize-jobs';

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 60)));
  const jobs = await listOrganizeJobs(user.id, pageSize);
  return ok({
    jobs,
    books: jobs.map((job) => job.book),
    total: jobs.length
  });
}

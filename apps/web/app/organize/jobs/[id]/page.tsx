import { requirePageUser } from '../../../../lib/auth';
import { OrganizeJobDetailPage } from '../../../../features/organize/organize-job-detail-page';

export default async function Page({ params }: { params: { id: string } }) {
  await requirePageUser();
  return <OrganizeJobDetailPage jobId={params.id} />;
}

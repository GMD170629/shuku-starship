import { requirePageUser } from '../../../lib/auth';
import { SourcesPage } from '../../../features/settings/sources-page';

export default async function Page() {
  await requirePageUser();
  return <SourcesPage />;
}

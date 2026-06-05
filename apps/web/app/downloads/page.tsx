import { requireUser } from '../../lib/auth';
import { DownloadsPage } from '../../features/downloads/downloads-page';

export default async function Page() {
  await requireUser();
  return <DownloadsPage />;
}

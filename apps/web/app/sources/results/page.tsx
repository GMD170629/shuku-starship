import { requirePageUser } from '../../../lib/auth';
import { SourceResultsPage } from '../../../features/sources/source-results-page';

export default async function Page() {
  await requirePageUser();
  return <SourceResultsPage />;
}

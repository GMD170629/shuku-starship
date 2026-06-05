import { requirePageUser } from '../../../lib/auth';
import { SourceSearchPage } from '../../../features/sources/source-search-page';

export default async function Page() {
  await requirePageUser();
  return <SourceSearchPage />;
}

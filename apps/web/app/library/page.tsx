import { requirePageUser } from '../../lib/auth';
import { LibraryPage } from '../../features/library/library-page';

export default async function Page() {
  await requirePageUser();
  return <LibraryPage />;
}

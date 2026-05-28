import { requirePageUser } from '../../lib/auth';
import { ShelvesPage } from '../../features/shelves/shelves-page';

export default async function Page() {
  await requirePageUser();
  return <ShelvesPage />;
}

import { requirePageUser } from '../../lib/auth';
import { ScanTasksPage } from '../../features/scan-tasks/scan-tasks-page';

export default async function Page() {
  await requirePageUser();
  return <ScanTasksPage />;
}

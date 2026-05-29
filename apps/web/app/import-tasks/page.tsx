import { requireUser } from '../../lib/auth';
import { ImportTasksPage } from '../../features/import-tasks/import-tasks-page';

export default async function Page() {
  await requireUser();
  return <ImportTasksPage />;
}

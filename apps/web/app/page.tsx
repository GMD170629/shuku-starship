import { requirePageUser } from '../lib/auth';
import { DashboardPage } from '../features/dashboard/dashboard-page';

export default async function HomePage() {
  await requirePageUser();
  return <DashboardPage />;
}

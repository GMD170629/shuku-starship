import { requirePageUser } from '../../lib/auth';
import { SettingsPage } from '../../features/settings/settings-page';

export default async function Page() {
  await requirePageUser();
  return <SettingsPage />;
}

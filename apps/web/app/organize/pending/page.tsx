import { requirePageUser } from '../../../lib/auth';
import { OrganizePage } from '../../../features/organize/organize-page';

export default async function Page() {
  await requirePageUser();
  return <OrganizePage />;
}

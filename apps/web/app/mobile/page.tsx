import { requirePageUser } from '../../lib/auth';
import { MobileReaderApp } from '../../components/mobile/mobile-reader-app';

export default async function Page() {
  await requirePageUser();
  return <MobileReaderApp />;
}

import { requirePageUser } from '../../../lib/auth';
import { ReaderPage } from '../../../features/reader/reader-page';

export default async function Page({ params }: { params: { id: string } }) {
  await requirePageUser();
  return <ReaderPage editionId={params.id} />;
}

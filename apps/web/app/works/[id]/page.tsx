import { requirePageUser } from '../../../lib/auth';
import { BookDetailPage } from '../../../features/works/book-detail-page';

export default async function Page({ params }: { params: { id: string } }) {
  await requirePageUser();
  return <BookDetailPage bookId={params.id} />;
}

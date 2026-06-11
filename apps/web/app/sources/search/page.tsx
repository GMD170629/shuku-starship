import { Suspense } from 'react';
import { SourceSearchPage } from '../../../features/sources/source-search-page';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SourceSearchPage />
    </Suspense>
  );
}

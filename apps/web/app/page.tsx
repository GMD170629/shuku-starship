import { AppShell } from '@/components/layout/app-shell';
import { mockBooks } from '@/data/mock-books';

export default function Page() {
  return <AppShell title="总览"><div className="text-sm text-slate-600">当前藏书 {mockBooks.length} 本，系统状态稳定。</div></AppShell>;
}

import { AppShell } from '@/components/layout/app-shell';
import { ReaderToolbar } from '@/components/reader/reader-toolbar';

export default function ReaderPage() {
  return <AppShell title="阅读器"><ReaderToolbar /><div className="mt-4 rounded border p-5 leading-8 text-slate-700">这里是正文阅读区域（Mock）。</div></AppShell>;
}

import { MobileFrame } from '@/components/mobile/mobile-frame';
import { mockBooks } from '@/data/mock-books';

export default function MobilePreviewPage(){return <main className="min-h-screen bg-slate-100 p-8"><MobileFrame><h1 className="mb-3 text-lg font-semibold">移动端预览</h1><div className="space-y-2">{mockBooks.map((b)=><div key={b.id} className="flex items-center gap-3 rounded border p-2"><div className={`h-12 w-9 rounded bg-gradient-to-br ${b.gradient}`} /><div className="text-sm">{b.title}</div></div>)}</div></MobileFrame></main>;}

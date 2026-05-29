import { WifiOff } from 'lucide-react';

export default function OfflinePage() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-slate-950 px-6 py-12 text-slate-100">
      <section className="w-full max-w-md text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-blue-200">
          <WifiOff size={26} />
        </div>
        <h1 className="mt-6 text-2xl font-semibold">当前网络不可用</h1>
        <p className="mt-4 text-sm leading-7 text-slate-300">你仍可以查看已缓存的页面</p>
        <p className="mt-2 text-sm leading-7 text-slate-300">阅读进度会暂存在本地，网络恢复后自动同步</p>
      </section>
    </main>
  );
}

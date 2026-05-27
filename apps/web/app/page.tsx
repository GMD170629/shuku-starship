import { Rocket } from 'lucide-react';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col items-center justify-center gap-4 p-6 text-center">
      <Rocket className="h-10 w-10 text-cyan-400" />
      <h1 className="text-3xl font-bold">书库星舰</h1>
      <p className="text-slate-300">Next.js + Node.js 全栈脚手架已就绪。</p>
      <p className="text-sm text-slate-400">健康检查接口：/api/health</p>
    </main>
  );
}

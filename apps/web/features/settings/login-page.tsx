'use client';

import { Library, Lock, Server, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Button } from '../../components/ui/button';

export function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState('admin@example.com');
  const [password, setPassword] = useState('starshipnas');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: login, username: login, password })
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    setLoading(false);
    if (!payload.ok) {
      setError(payload.error?.message ?? '登录失败');
      return;
    }
    const next = new URLSearchParams(window.location.search).get('next');
    const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : '/library';
    router.replace(safeNext);
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(135deg,#F8FAFC_0%,#EEF2F7_55%,#F6F7F9_100%)] p-8">
      <form onSubmit={submit} className="w-full max-w-md rounded-[28px] border border-white/70 bg-white/90 p-8 shadow-xl shadow-slate-200/60 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl bg-slate-950 text-white">
          <Library size={26} />
        </div>
        <h1 className="mt-6 text-center text-2xl font-semibold tracking-tight text-slate-950">欢迎回到书库星舰</h1>
        <p className="mt-2 text-center text-sm text-slate-500">管理你的私人数字书库</p>
        <div className="mt-8 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">账号</span>
            <input value={login} onChange={(event) => setLogin(event.target.value)} className="mt-2 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none ring-blue-100 transition focus:border-blue-500 focus:ring-4" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">密码</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none ring-blue-100 transition focus:border-blue-500 focus:ring-4" />
          </label>
          {error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
          <Button className="h-12 w-full" disabled={loading}>{loading ? '登录中...' : '登录'}</Button>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-2 text-center text-xs text-slate-500">
          <div className="rounded-2xl bg-slate-50 p-3"><Server className="mx-auto mb-1" size={16} />NAS 在线</div>
          <div className="rounded-2xl bg-slate-50 p-3"><Lock className="mx-auto mb-1" size={16} />私有部署</div>
          <div className="rounded-2xl bg-slate-50 p-3"><ShieldCheck className="mx-auto mb-1" size={16} />安全连接</div>
        </div>
      </form>
    </div>
  );
}

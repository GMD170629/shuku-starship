import Link from 'next/link';

const nav = [
  ['总览', '/'],
  ['书库', '/library'],
  ['书架', '/shelves'],
  ['整理', '/organize'],
  ['扫描任务', '/scan-tasks'],
  ['设置', '/settings']
] as const;

export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-6 px-6 py-6">
        <aside className="col-span-12 rounded-xl border bg-white p-4 lg:col-span-2">
          <div className="mb-4 text-lg font-semibold">书库星舰</div>
          <nav className="space-y-1 text-sm">
            {nav.map(([name, href]) => (
              <Link key={href} className="block rounded-md px-3 py-2 hover:bg-slate-100" href={href}>{name}</Link>
            ))}
          </nav>
        </aside>
        <section className="col-span-12 rounded-xl border bg-white p-6 lg:col-span-10">
          <h1 className="mb-5 text-2xl font-semibold">{title}</h1>
          {children}
        </section>
      </div>
    </div>
  );
}

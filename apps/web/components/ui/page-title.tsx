import type { ReactNode } from 'react';

export function PageTitle({ title, desc, action }: { title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{title}</h1>
        <p className="mt-2 text-slate-500">{desc}</p>
      </div>
      {action}
    </div>
  );
}

'use client';
import { useState } from 'react';

export function SettingSwitch({ label, defaultOn }: { label: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(Boolean(defaultOn));
  return (
    <button onClick={() => setOn((v) => !v)} className="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left">
      <span>{label}</span>
      <span className={`rounded-full px-2 py-1 text-xs ${on ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{on ? '开启' : '关闭'}</span>
    </button>
  );
}

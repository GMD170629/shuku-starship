import { scanLogs } from '@/data/mock-books';

export function ScanLogPanel() {
  return (
    <div className="rounded-lg border bg-slate-950 p-4 font-mono text-sm text-slate-200">
      <div className="mb-2 text-emerald-400">状态：运行中</div>
      {scanLogs.map((line) => <div key={line} className="leading-6">{line}</div>)}
    </div>
  );
}

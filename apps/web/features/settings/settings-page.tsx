'use client';

import { AlertTriangle, CheckCircle2, ChevronRight, Database, Download, FolderOpen, KeyRound, RefreshCw, RotateCcw, Save, Smartphone, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';

type LibraryPath = {
  id: string;
  name: string;
  rootPath: string;
  enabled: boolean;
  scanPolicy: string;
  ignorePatterns?: string | null;
  ignoreHidden: boolean;
  minFileSizeBytes: number;
  description?: string | null;
};

type BackupItem = {
  id: string;
  kind: 'manual' | 'automatic' | 'unknown';
  filename: string;
  sizeBytes: number;
  createdAt: string;
  counts?: {
    books: number;
    readingProgresses: number;
    libraryPaths: number;
  };
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
];

export function SettingsPage() {
  const groups = ['基础设置', '书库路径', '扫描规则', '备份与恢复', '元数据', '用户与权限', '多端同步', '安全与 API'];
  const [active, setActive] = useState('书库路径');
  const [paths, setPaths] = useState<LibraryPath[]>([]);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [health, setHealth] = useState<{ status: string; checks: Array<{ name: string; status: string; message: string }> } | null>(null);
  const [summary, setSummary] = useState<{ latestSyncAt: string | null } | null>(null);
  const [settings, setSettings] = useState({ systemName: '书库星舰', theme: 'system', language: 'zh-CN', timezone: 'Asia/Shanghai' });
  const [name, setName] = useState('我的书库');
  const [rootPath, setRootPath] = useState('/books');
  const [ignorePatterns, setIgnorePatterns] = useState('');
  const [ignoreHidden, setIgnoreHidden] = useState(true);
  const [minFileSizeKb, setMinFileSizeKb] = useState('10');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [backupBusy, setBackupBusy] = useState('');

  async function loadPaths() {
    const response = await fetch('/api/library-paths');
    const payload = (await response.json()) as { ok: boolean; data?: { paths: LibraryPath[] }; error?: { message: string } };
    if (payload.ok) setPaths(payload.data?.paths ?? []);
    else setError(payload.error?.message ?? '读取书库路径失败');
  }

  async function loadBackups() {
    const response = await fetch('/api/backups');
    const payload = (await response.json()) as { ok: boolean; data?: { backups: BackupItem[] }; error?: { message: string } };
    if (payload.ok) setBackups(payload.data?.backups ?? []);
    else setError(payload.error?.message ?? '读取备份列表失败');
  }

  useEffect(() => {
    loadPaths();
    loadBackups();
    fetch('/api/system/health').then((response) => response.json()).then((payload) => payload.ok && setHealth(payload.data)).catch(() => undefined);
    fetch('/api/dashboard/summary').then((response) => response.json()).then((payload) => payload.ok && setSummary(payload.data)).catch(() => undefined);
    fetch('/api/system-settings').then((response) => response.json()).then((payload) => payload.ok && setSettings((current) => ({ ...current, ...payload.data.settings }))).catch(() => undefined);
  }, []);

  async function savePath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    const response = await fetch('/api/library-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rootPath, enabled: true, scanPolicy: 'manual', ignorePatterns, ignoreHidden, minFileSizeBytes: Math.max(0, Math.round(Number(minFileSizeKb || 0) * 1024)) })
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) {
      setError(payload.error?.message ?? '保存失败');
      return;
    }
    setMessage('书库路径已保存');
    await loadPaths();
  }

  async function togglePath(path: LibraryPath) {
    await fetch(`/api/library-paths/${path.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !path.enabled })
    });
    await loadPaths();
  }

  async function deletePath(path: LibraryPath) {
    await fetch(`/api/library-paths/${path.id}`, { method: 'DELETE' });
    await loadPaths();
  }

  async function saveScanRules(path: LibraryPath, updates: Pick<LibraryPath, 'ignorePatterns' | 'ignoreHidden' | 'minFileSizeBytes'>) {
    setError('');
    setMessage('');
    const response = await fetch(`/api/library-paths/${path.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) {
      setError(payload.error?.message ?? '保存扫描规则失败');
      return;
    }
    setMessage('扫描规则已保存');
    await loadPaths();
  }

  async function createBackup() {
    setError('');
    setMessage('');
    setBackupBusy('create');
    const response = await fetch('/api/backups', { method: 'POST' });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    setBackupBusy('');
    if (!payload.ok) {
      setError(payload.error?.message ?? '创建备份失败');
      return;
    }
    setMessage('备份已创建');
    await loadBackups();
  }

  function downloadBackup(backup: BackupItem) {
    window.location.href = `/api/backups/${backup.id}/download`;
  }

  async function restoreBackup(backup: BackupItem) {
    const first = window.confirm('恢复备份会覆盖当前书库元数据、标签、阅读进度和书库路径配置，但不会删除原始读物文件。是否继续？');
    if (!first) return;
    const confirmText = window.prompt(`二次确认：请输入 RESTORE 恢复备份 ${backup.filename}`);
    if (confirmText !== 'RESTORE') {
      setError('恢复已取消：确认文本不匹配');
      return;
    }
    setError('');
    setMessage('');
    setBackupBusy(`restore:${backup.id}`);
    const response = await fetch(`/api/backups/${backup.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmText })
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    setBackupBusy('');
    if (!payload.ok) {
      setError(payload.error?.message ?? '恢复备份失败');
      return;
    }
    setMessage('备份已恢复，原始读物文件未被删除');
    await Promise.all([loadPaths(), loadBackups()]);
  }

  async function deleteBackup(backup: BackupItem) {
    const confirmed = window.confirm(`删除备份 ${backup.filename}？`);
    if (!confirmed) return;
    setError('');
    setMessage('');
    setBackupBusy(`delete:${backup.id}`);
    const response = await fetch(`/api/backups/${backup.id}`, { method: 'DELETE' });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    setBackupBusy('');
    if (!payload.ok) {
      setError(payload.error?.message ?? '删除备份失败');
      return;
    }
    setMessage('备份已删除');
    await loadBackups();
  }

  async function saveSettings() {
    setError('');
    setMessage('');
    const response = await fetch('/api/system-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) setError(payload.error?.message ?? '保存设置失败');
    else setMessage('系统设置已保存');
  }

  return (
    <div className="space-y-6">
      <PageTitle title="系统设置" desc="配置系统、书库路径、扫描规则、同步、安全和备份。" action={<Button icon={CheckCircle2} onClick={saveSettings}>保存设置</Button>} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm lg:col-span-3">
          {groups.map((group) => (
            <button
              key={group}
              onClick={() => setActive(group)}
              className={cn('mb-1 flex w-full items-center justify-between rounded-2xl px-4 py-3 text-sm', active === group ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50')}
            >
              <span>{group}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm lg:col-span-9">
          <h1 className="text-xl font-semibold">{active}</h1>
          {active === '基础设置' ? (
            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="text-sm text-slate-600">
                系统名称
                <input value={settings.systemName} onChange={(event) => setSettings({ ...settings, systemName: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none" />
              </label>
              <label className="text-sm text-slate-600">
                主题
                <Select value={settings.theme} options={themeOptions} onChange={(theme) => setSettings({ ...settings, theme })} ariaLabel="主题" className="mt-2 w-full" />
              </label>
              <label className="text-sm text-slate-600">
                语言
                <input value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none" />
              </label>
              <label className="text-sm text-slate-600">
                时区
                <input value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none" />
              </label>
            </div>
          ) : active === '书库路径' ? (
            <div className="mt-6 space-y-5">
              <form onSubmit={savePath} className="grid grid-cols-1 gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:grid-cols-12">
                <label className="md:col-span-4">
                  <span className="text-sm font-medium text-slate-700">名称</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                </label>
                <label className="md:col-span-6">
                  <span className="text-sm font-medium text-slate-700">NAS 根路径</span>
                  <input value={rootPath} onChange={(event) => setRootPath(event.target.value)} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                </label>
                <label className="md:col-span-9">
                  <span className="text-sm font-medium text-slate-700">自定义忽略规则</span>
                  <textarea
                    value={ignorePatterns}
                    onChange={(event) => setIgnorePatterns(event.target.value)}
                    rows={4}
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 font-mono text-sm outline-none"
                  />
                </label>
                <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 md:col-span-3 md:mt-7">
                  <input type="checkbox" checked={ignoreHidden} onChange={(event) => setIgnoreHidden(event.target.checked)} />
                  忽略隐藏文件
                </label>
                <label className="md:col-span-3">
                  <span className="text-sm font-medium text-slate-700">最小文件大小 KB</span>
                  <input type="number" min={0} value={minFileSizeKb} onChange={(event) => setMinFileSizeKb(event.target.value)} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                </label>
                <div className="flex items-end md:col-span-2">
                  <Button className="h-11 w-full" icon={FolderOpen}>保存</Button>
                </div>
                {message ? <div className="md:col-span-12 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
                {error ? <div className="md:col-span-12 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
              </form>
              <div className="space-y-3">
                {paths.map((path) => (
                  <div key={path.id} className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 md:flex-row md:items-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                      <FolderOpen size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{path.name}</div>
                      <div className="break-words text-sm text-slate-500">{path.rootPath}</div>
                      <div className="mt-2 text-xs text-slate-500">{path.ignoreHidden ? '忽略隐藏文件' : '包含隐藏文件'} · 小于 {Math.round((path.minFileSizeBytes ?? 10240) / 1024)} KB 跳过 · {path.ignorePatterns?.trim() ? '已配置自定义忽略规则' : '仅默认忽略规则'}</div>
                    </div>
                    <button onClick={() => togglePath(path)} className={cn('h-7 w-12 rounded-full p-1 transition', path.enabled ? 'bg-blue-600' : 'bg-slate-300')} aria-label="启用书库路径">
                      <span className={cn('block h-5 w-5 rounded-full bg-white transition', path.enabled && 'translate-x-5')} />
                    </button>
                    <Button variant="danger" icon={Trash2} onClick={() => deletePath(path)}>删除</Button>
                  </div>
                ))}
                {paths.length === 0 ? <div className="rounded-3xl bg-slate-50 p-6 text-sm text-slate-500">尚未保存书库路径。</div> : null}
              </div>
            </div>
          ) : active === '扫描规则' ? (
            <div className="mt-6 space-y-4">
              {paths.map((path) => (
                <ScanRuleEditor key={path.id} path={path} onSave={saveScanRules} />
              ))}
              {paths.length === 0 ? <div className="rounded-3xl bg-slate-50 p-6 text-sm text-slate-500">请先添加书库路径。</div> : null}
            </div>
          ) : active === '备份与恢复' ? (
            <div className="mt-6 space-y-5">
              <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="font-semibold">备份范围</div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">数据库数据、读物元数据、标签、阅读进度、书库路径配置和封面缓存索引。原始读物文件不会写入备份。</div>
                  <div className="mt-2 text-xs text-slate-500">自动备份未配置；当前仅显示真实备份文件。</div>
                </div>
                <Button icon={Save} onClick={createBackup} disabled={backupBusy === 'create'}>{backupBusy === 'create' ? '创建中' : '立即备份'}</Button>
              </div>
              {message ? <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
              {error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
              <div className="space-y-3">
                {backups.map((backup) => (
                  <div key={backup.id} className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 md:flex-row md:items-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                      <Database size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{backup.filename}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{backup.kind === 'automatic' ? '自动' : backup.kind === 'manual' ? '手动' : '未知'}</span>
                      </div>
                      <div className="mt-1 text-sm text-slate-500">{new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.sizeBytes)}</div>
                      {backup.counts ? (
                        <div className="mt-2 text-xs text-slate-500">
                          {backup.counts.books} 本读物 · {backup.counts.readingProgresses} 条阅读进度 · {backup.counts.libraryPaths} 个书库路径
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" icon={Download} onClick={() => downloadBackup(backup)}>下载</Button>
                      <Button variant="secondary" icon={RotateCcw} onClick={() => restoreBackup(backup)} disabled={backupBusy === `restore:${backup.id}`}>
                        {backupBusy === `restore:${backup.id}` ? '恢复中' : '恢复'}
                      </Button>
                      <Button variant="danger" icon={Trash2} onClick={() => deleteBackup(backup)} disabled={backupBusy === `delete:${backup.id}`}>删除</Button>
                    </div>
                  </div>
                ))}
                {backups.length === 0 ? <div className="rounded-3xl bg-slate-50 p-6 text-sm text-slate-500">尚未创建备份。</div> : null}
              </div>
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
              {[
                { icon: RefreshCw, title: '自动扫描', desc: paths.some((path) => path.scanPolicy !== 'manual') ? '已启用自动扫描策略。' : '未配置自动扫描。' },
                { icon: Database, title: 'NAS 连接状态', desc: health?.checks.find((check) => check.name === 'booksRootReadable')?.message ?? '待检测' },
                { icon: Smartphone, title: '多端同步', desc: summary?.latestSyncAt ? `最近进度更新 ${new Date(summary.latestSyncAt).toLocaleString()}` : '暂无阅读进度同步' },
                { icon: KeyRound, title: 'API Token', desc: '尚未启用 API Token。' }
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-blue-600 shadow-sm"><Icon size={18} /></div>
                    <div>
                      <div className="font-semibold">{title}</div>
                      <div className="mt-1 text-sm leading-6 text-slate-500">{desc}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-6 rounded-3xl border border-red-100 bg-red-50 p-5">
            <div className="flex items-center gap-2 font-semibold text-red-700">
              <AlertTriangle size={18} />危险操作
            </div>
            <p className="mt-2 text-sm text-red-600">重建索引、清空缩略图缓存和恢复备份会影响当前服务状态，请谨慎操作。</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScanRuleEditor({ path, onSave }: { path: LibraryPath; onSave: (path: LibraryPath, updates: Pick<LibraryPath, 'ignorePatterns' | 'ignoreHidden' | 'minFileSizeBytes'>) => Promise<void> }) {
  const [patterns, setPatterns] = useState(path.ignorePatterns ?? '');
  const [hidden, setHidden] = useState(path.ignoreHidden);
  const [minSizeKb, setMinSizeKb] = useState(String(Math.round((path.minFileSizeBytes ?? 10240) / 1024)));

  useEffect(() => {
    setPatterns(path.ignorePatterns ?? '');
    setHidden(path.ignoreHidden);
    setMinSizeKb(String(Math.round((path.minFileSizeBytes ?? 10240) / 1024)));
  }, [path]);

  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="font-semibold">{path.name}</div>
          <div className="mt-1 break-words text-sm text-slate-500">{path.rootPath}</div>
        </div>
        <label className="flex items-center gap-3 rounded-2xl bg-white px-4 py-2 text-sm text-slate-700">
          <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
          忽略隐藏文件
        </label>
      </div>
      <label className="mt-4 block text-sm text-slate-600">
        小于此大小的文件跳过（KB）
        <input
          type="number"
          min={0}
          value={minSizeKb}
          onChange={(event) => setMinSizeKb(event.target.value)}
          className="mt-2 h-11 w-full max-w-xs rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none"
        />
      </label>
      <textarea
        value={patterns}
        onChange={(event) => setPatterns(event.target.value)}
        rows={6}
        className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm outline-none"
      />
      <div className="mt-2 text-xs leading-5 text-slate-500">默认已忽略封面、缩略图、临时文件、说明文件和普通图片；这里填写额外规则，每行一条。</div>
      <div className="mt-3 flex justify-end">
        <Button type="button" icon={CheckCircle2} onClick={() => onSave(path, { ignorePatterns: patterns, ignoreHidden: hidden, minFileSizeBytes: Math.max(0, Math.round(Number(minSizeKb || 0) * 1024)) })}>保存规则</Button>
      </div>
    </div>
  );
}

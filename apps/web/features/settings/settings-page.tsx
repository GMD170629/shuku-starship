'use client';

import { AlertTriangle, CheckCircle2, ChevronRight, Database, Download, FolderOpen, KeyRound, RefreshCw, RotateCcw, Save, Smartphone, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { useConfirm, useToast } from '../../components/ui/feedback';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';

type MonitorFolder = {
  id: string;
  name: string;
  rootPath: string;
  enabled: boolean;
  importMode: 'COPY' | 'MOVE';
  ignorePatterns?: string | null;
  ignoreHidden: boolean;
  minFileSizeBytes: number;
  description?: string | null;
};

type MonitorFoldersPayload = {
  folders: MonitorFolder[];
  monitorRoot?: string;
};

type BackupItem = {
  id: string;
  kind: 'manual' | 'automatic' | 'unknown';
  filename: string;
  sizeBytes: number;
  createdAt: string;
  counts?: {
    works: number;
    readingProgresses: number;
    monitorFolders: number;
  };
};

type AppSettings = {
  systemName: string;
  theme: string;
  language: string;
  timezone: string;
  [key: string]: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toggleExternalSettings(settings: AppSettings, enabled: boolean): AppSettings {
  return {
    ...settings,
    'metadata.external.enabled': String(enabled),
    'metadata.douban.enabled': String(enabled),
    'metadata.bangumi.enabled': String(enabled)
  };
}

function toggleExternalProvider(settings: AppSettings, providerKey: 'metadata.douban.enabled' | 'metadata.bangumi.enabled', enabled: boolean): AppSettings {
  return {
    ...settings,
    'metadata.external.enabled': String(enabled || settings['metadata.external.enabled'] === 'true'),
    [providerKey]: String(enabled)
  };
}

function hasCompleteAiSettings(settings: AppSettings) {
  return Boolean(settings['metadata.ai.baseUrl']?.trim() && settings['metadata.ai.model']?.trim() && settings['metadata.ai.apiKey']?.trim());
}

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
];

const importModeOptions = [
  { value: 'COPY', label: '复制到项目文件夹' },
  { value: 'MOVE', label: '移动到项目文件夹' }
];

export function SettingsPage() {
  const groups = ['基础设置', '监控文件夹', '监控规则', '备份与恢复', '元数据', '源管理', '用户与权限', '多端同步', '安全与 API'];
  const [active, setActive] = useState('监控文件夹');
  const [folders, setFolders] = useState<MonitorFolder[]>([]);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [health, setHealth] = useState<{ status: string; checks: Array<{ name: string; status: string; message: string }> } | null>(null);
  const [summary, setSummary] = useState<{ latestSyncAt: string | null } | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
    systemName: '书库星舰',
    theme: 'system',
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    'metadata.external.enabled': 'false',
    'metadata.douban.enabled': 'false',
    'metadata.douban.mode': 'crawler',
    'metadata.douban.baseUrl': '',
    'metadata.douban.apiKey': '',
    'metadata.douban.userAgent': 'ShukuStarship/0.1 (+https://github.com/GMD170629/shuku-starship)',
    'metadata.bangumi.enabled': 'false',
    'metadata.bangumi.accessToken': '',
    'metadata.bangumi.userAgent': 'ShukuStarship/0.1 (https://github.com/GMD170629/shuku-starship)',
    'metadata.ai.enabled': 'false',
    'metadata.ai.baseUrl': '',
    'metadata.ai.apiKey': '',
    'metadata.ai.model': ''
  });
  const [name, setName] = useState('我的监控文件夹');
  const [rootPath, setRootPath] = useState('/books');
  const [importMode, setImportMode] = useState<'COPY' | 'MOVE'>('COPY');
  const [ignorePatterns, setIgnorePatterns] = useState('');
  const [ignoreHidden, setIgnoreHidden] = useState(true);
  const [minFileSizeKb, setMinFileSizeKb] = useState('0');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [backupBusy, setBackupBusy] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [pathBusy, setPathBusy] = useState('');
  const [ruleBusy, setRuleBusy] = useState('');
  const confirm = useConfirm();
  const toast = useToast();

  async function loadPaths() {
    const response = await fetch('/api/monitor-folders');
    const payload = (await response.json()) as { ok: boolean; data?: MonitorFoldersPayload; error?: { message: string } };
    if (payload.ok) {
      setFolders(payload.data?.folders ?? []);
      if (payload.data?.monitorRoot && rootPath === '/books') setRootPath(payload.data.monitorRoot);
    } else {
      setError(payload.error?.message ?? '读取监控文件夹失败');
    }
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
    setPathBusy('create');
    const response = await fetch('/api/monitor-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rootPath, enabled: true, importMode, ignorePatterns, ignoreHidden, minFileSizeBytes: Math.max(0, Math.round(Number(minFileSizeKb || 0) * 1024)) })
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) {
      const nextError = payload.error?.message ?? '保存失败';
      setError(nextError);
      toast.error('保存失败', nextError);
      setPathBusy('');
      return;
    }
    setMessage('监控文件夹已保存');
    toast.success('监控文件夹已保存');
    await loadPaths();
    setPathBusy('');
  }

  async function togglePath(path: MonitorFolder) {
    setPathBusy(`toggle:${path.id}`);
    await fetch(`/api/monitor-folders/${path.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !path.enabled })
    });
    await loadPaths();
    toast.success(path.enabled ? '监控文件夹已停用' : '监控文件夹已启用');
    setPathBusy('');
  }

  async function deletePath(path: MonitorFolder) {
    const confirmed = await confirm({
      title: '删除监控文件夹',
      description: `删除监控文件夹“${path.name}”？不会删除原始读物文件。`,
      confirmLabel: '删除',
      tone: 'danger'
    });
    if (!confirmed) return;
    setPathBusy(`delete:${path.id}`);
    await fetch(`/api/monitor-folders/${path.id}`, { method: 'DELETE' });
    await loadPaths();
    toast.success('监控文件夹已删除');
    setPathBusy('');
  }

  async function saveScanRules(path: MonitorFolder, updates: Pick<MonitorFolder, 'importMode' | 'ignorePatterns' | 'ignoreHidden' | 'minFileSizeBytes'>) {
    setError('');
    setMessage('');
    setRuleBusy(path.id);
    const response = await fetch(`/api/monitor-folders/${path.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) {
      const nextError = payload.error?.message ?? '保存监控规则失败';
      setError(nextError);
      toast.error('保存监控规则失败', nextError);
      setRuleBusy('');
      return;
    }
    setMessage('监控规则已保存');
    toast.success('监控规则已保存');
    await loadPaths();
    setRuleBusy('');
  }

  async function createBackup() {
    setError('');
    setMessage('');
    setBackupBusy('create');
    const response = await fetch('/api/backups', { method: 'POST' });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    setBackupBusy('');
    if (!payload.ok) {
      const nextError = payload.error?.message ?? '创建备份失败';
      setError(nextError);
      toast.error('创建备份失败', nextError);
      return;
    }
    setMessage('备份已创建');
    toast.success('备份已创建');
    await loadBackups();
  }

  function downloadBackup(backup: BackupItem) {
    window.location.href = `/api/backups/${backup.id}/download`;
  }

  async function restoreBackup(backup: BackupItem) {
    const first = await confirm({
      title: '恢复备份',
      description: '恢复备份会覆盖当前读物元数据、标签、阅读进度和监控文件夹配置，但不会删除原始读物文件。是否继续？',
      confirmLabel: '继续恢复',
      tone: 'danger'
    });
    if (!first) return;
    const confirmText = window.prompt(`二次确认：请输入 RESTORE 恢复备份 ${backup.filename}`);
    if (confirmText !== 'RESTORE') {
      setError('恢复已取消：确认文本不匹配');
      toast.info('恢复已取消', '确认文本不匹配');
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
      const nextError = payload.error?.message ?? '恢复备份失败';
      setError(nextError);
      toast.error('恢复备份失败', nextError);
      return;
    }
    setMessage('备份已恢复，原始读物文件未被删除');
    toast.success('备份已恢复', '原始读物文件未被删除');
    await Promise.all([loadPaths(), loadBackups()]);
  }

  async function deleteBackup(backup: BackupItem) {
    const confirmed = await confirm({
      title: '删除备份',
      description: `删除备份 ${backup.filename}？`,
      confirmLabel: '删除',
      tone: 'danger'
    });
    if (!confirmed) return;
    setError('');
    setMessage('');
    setBackupBusy(`delete:${backup.id}`);
    const response = await fetch(`/api/backups/${backup.id}`, { method: 'DELETE' });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    setBackupBusy('');
    if (!payload.ok) {
      const nextError = payload.error?.message ?? '删除备份失败';
      setError(nextError);
      toast.error('删除备份失败', nextError);
      return;
    }
    setMessage('备份已删除');
    toast.success('备份已删除');
    await loadBackups();
  }

  async function saveSettings() {
    setError('');
    setMessage('');
    setSettingsBusy(true);
    const settingsToSave = hasCompleteAiSettings(settings)
      ? { ...settings, 'metadata.ai.enabled': 'true' }
      : settings;
    const response = await fetch('/api/system-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsToSave)
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    setSettingsBusy(false);
    if (!payload.ok) {
      const nextError = payload.error?.message ?? '保存设置失败';
      setError(nextError);
      toast.error('保存设置失败', nextError);
    } else {
      setSettings(settingsToSave);
      setMessage('系统设置已保存');
      toast.success('系统设置已保存');
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="系统设置" desc="配置系统、监控文件夹、监控规则、同步、安全和备份。" action={<Button icon={CheckCircle2} loading={settingsBusy} loadingText="保存中" onClick={saveSettings}>保存设置</Button>} />
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
          ) : active === '监控文件夹' ? (
            <div className="mt-6 space-y-5">
              <form onSubmit={savePath} className="grid grid-cols-1 gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:grid-cols-12">
                <label className="md:col-span-3">
                  <span className="text-sm font-medium text-slate-700">名称</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                </label>
                <label className="md:col-span-6">
                  <span className="text-sm font-medium text-slate-700">监控文件夹路径</span>
                  <input value={rootPath} onChange={(event) => setRootPath(event.target.value)} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                </label>
                <label className="md:col-span-3">
                  <span className="text-sm font-medium text-slate-700">添加模式</span>
                  <Select value={importMode} options={importModeOptions} onChange={(value) => setImportMode(value as 'COPY' | 'MOVE')} ariaLabel="添加模式" className="mt-2 w-full" />
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
                  <Button className="h-11 w-full" icon={FolderOpen} loading={pathBusy === 'create'} loadingText="保存中">保存</Button>
                </div>
                {message ? <div className="md:col-span-12 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
                {error ? <div className="md:col-span-12 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
              </form>
              <div className="space-y-3">
                {folders.map((path) => (
                  <div key={path.id} className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 md:flex-row md:items-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                      <FolderOpen size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{path.name}</div>
                      <div className="break-words text-sm text-slate-500">{path.rootPath}</div>
                      <div className="mt-2 text-xs text-slate-500">{path.importMode === 'MOVE' ? '移动到项目文件夹' : '复制到项目文件夹'} · {path.ignoreHidden ? '忽略隐藏文件' : '包含隐藏文件'} · 小于 {Math.round((path.minFileSizeBytes ?? 0) / 1024)} KB 跳过 · {path.ignorePatterns?.trim() ? '已配置自定义忽略规则' : '仅默认忽略规则'}</div>
                    </div>
                    <button disabled={pathBusy === `toggle:${path.id}`} onClick={() => togglePath(path)} className={cn('h-7 w-12 rounded-full p-1 transition disabled:cursor-not-allowed disabled:opacity-60', path.enabled ? 'bg-blue-600' : 'bg-slate-300')} aria-label="启用监控文件夹">
                      <span className={cn('block h-5 w-5 rounded-full bg-white transition', path.enabled && 'translate-x-5')} />
                    </button>
                    <Button variant="danger" icon={Trash2} loading={pathBusy === `delete:${path.id}`} loadingText="删除中" onClick={() => deletePath(path)}>删除</Button>
                  </div>
                ))}
                {folders.length === 0 ? <div className="rounded-3xl bg-slate-50 p-6 text-sm text-slate-500">尚未保存监控文件夹。</div> : null}
              </div>
            </div>
          ) : active === '监控规则' ? (
            <div className="mt-6 space-y-4">
              {folders.map((path) => (
                <ScanRuleEditor key={path.id} path={path} saving={ruleBusy === path.id} onSave={saveScanRules} />
              ))}
              {folders.length === 0 ? <div className="rounded-3xl bg-slate-50 p-6 text-sm text-slate-500">请先添加监控文件夹。</div> : null}
            </div>
          ) : active === '备份与恢复' ? (
            <div className="mt-6 space-y-5">
              <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="font-semibold">备份范围</div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">数据库数据、读物元数据、标签、阅读进度、监控文件夹配置和封面缓存索引。原始读物文件不会写入备份。</div>
                  <div className="mt-2 text-xs text-slate-500">自动备份未配置；当前仅显示真实备份文件。</div>
                </div>
                <Button icon={Save} onClick={createBackup} loading={backupBusy === 'create'} loadingText="创建中">立即备份</Button>
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
                          {backup.counts.works} 部作品 · {backup.counts.readingProgresses} 条阅读进度 · {backup.counts.monitorFolders} 个监控文件夹
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" icon={Download} onClick={() => downloadBackup(backup)}>下载</Button>
                      <Button variant="secondary" icon={RotateCcw} onClick={() => restoreBackup(backup)} loading={backupBusy === `restore:${backup.id}`} loadingText="恢复中">恢复</Button>
                      <Button variant="danger" icon={Trash2} onClick={() => deleteBackup(backup)} loading={backupBusy === `delete:${backup.id}`} loadingText="删除中">删除</Button>
                    </div>
                  </div>
                ))}
                {backups.length === 0 ? <div className="rounded-3xl bg-slate-50 p-6 text-sm text-slate-500">尚未创建备份。</div> : null}
              </div>
            </div>
          ) : active === '元数据' ? (
            <div className="mt-6 space-y-5">
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-semibold">外部数据源</div>
                    <div className="mt-1 text-sm text-slate-500">电子书使用豆瓣图书抓取或兼容 API，漫画使用 Bangumi 官方 API。打开总开关会启用两个外部来源，导入后仅自动应用高置信度建议。</div>
                  </div>
                  <label className="flex items-center gap-3 rounded-2xl bg-white px-4 py-2 text-sm text-slate-700">
                    <input type="checkbox" checked={settings['metadata.external.enabled'] === 'true'} onChange={(event) => setSettings(toggleExternalSettings(settings, event.target.checked))} />
                    启用外部元数据
                  </label>
                </div>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <section className="rounded-3xl border border-slate-200 bg-white p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">豆瓣图书</h2>
                      <p className="mt-1 text-sm text-slate-500">用于 EPUB。默认直接抓取豆瓣读书页面，也可切换到兼容 JSON API。</p>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={settings['metadata.douban.enabled'] === 'true'} onChange={(event) => setSettings(toggleExternalProvider(settings, 'metadata.douban.enabled', event.target.checked))} />
                      启用
                    </label>
                  </div>
                  <label className="mt-4 block text-sm text-slate-600">
                    获取方式
                    <Select
                      value={settings['metadata.douban.mode'] || 'crawler'}
                      options={[
                        { value: 'crawler', label: '直接抓取网页' },
                        { value: 'api', label: '兼容 JSON API' }
                      ]}
                      onChange={(value) => setSettings({ ...settings, 'metadata.douban.mode': value })}
                      ariaLabel="豆瓣获取方式"
                      className="mt-2 w-full"
                    />
                  </label>
                  <label className="mt-4 block text-sm text-slate-600">
                    地址
                    <input value={settings['metadata.douban.baseUrl']} onChange={(event) => setSettings({ ...settings, 'metadata.douban.baseUrl': event.target.value })} placeholder={settings['metadata.douban.mode'] === 'api' ? 'https://example.com' : 'https://book.douban.com'} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                  <label className="mt-4 block text-sm text-slate-600">
                    API Key
                    <input type="password" value={settings['metadata.douban.apiKey']} onChange={(event) => setSettings({ ...settings, 'metadata.douban.apiKey': event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                  <label className="mt-4 block text-sm text-slate-600">
                    User-Agent
                    <input value={settings['metadata.douban.userAgent']} onChange={(event) => setSettings({ ...settings, 'metadata.douban.userAgent': event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                </section>

                <section className="rounded-3xl border border-slate-200 bg-white p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">Bangumi 漫画</h2>
                      <p className="mt-1 text-sm text-slate-500">用于漫画。User-Agent 为必填，Access Token 可选。</p>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={settings['metadata.bangumi.enabled'] === 'true'} onChange={(event) => setSettings(toggleExternalProvider(settings, 'metadata.bangumi.enabled', event.target.checked))} />
                      启用
                    </label>
                  </div>
                  <label className="mt-4 block text-sm text-slate-600">
                    User-Agent
                    <input value={settings['metadata.bangumi.userAgent']} onChange={(event) => setSettings({ ...settings, 'metadata.bangumi.userAgent': event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                  <label className="mt-4 block text-sm text-slate-600">
                    Access Token
                    <input type="password" value={settings['metadata.bangumi.accessToken']} onChange={(event) => setSettings({ ...settings, 'metadata.bangumi.accessToken': event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                </section>
              </div>

              <section className="rounded-3xl border border-slate-200 bg-white p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="font-semibold">AI 元数据识别</h2>
                    <p className="mt-1 text-sm text-slate-500">使用 OpenAI-compatible Chat Completions，仅发送本地元数据摘要，不读取正文全文；API 地址、模型和 Key 填写完整后保存会启用 AI 识别。</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={settings['metadata.ai.enabled'] === 'true'} onChange={(event) => setSettings({ ...settings, 'metadata.ai.enabled': String(event.target.checked) })} />
                    启用
                  </label>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <label className="text-sm text-slate-600">
                    API 地址
                    <input value={settings['metadata.ai.baseUrl']} onChange={(event) => setSettings({ ...settings, 'metadata.ai.baseUrl': event.target.value })} placeholder="https://api.openai.com/v1" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                  <label className="text-sm text-slate-600">
                    模型
                    <input value={settings['metadata.ai.model']} onChange={(event) => setSettings({ ...settings, 'metadata.ai.model': event.target.value })} placeholder="gpt-4.1-mini" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                  <label className="text-sm text-slate-600">
                    API Key
                    <input type="password" value={settings['metadata.ai.apiKey']} onChange={(event) => setSettings({ ...settings, 'metadata.ai.apiKey': event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                  </label>
                </div>
              </section>
              {message ? <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
              {error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
            </div>
          ) : active === '源管理' ? (
            <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <div className="font-semibold">通用来源配置</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">集中管理手动源、PT RSS、Z-Library Telegram Bot、漫画 API、通用 RSS 和 HTTP 源。可保存配置、脱敏展示，并通过已注册 Provider 执行测试和搜索。</div>
              <Link href="/settings/sources" className="mt-4 inline-flex min-h-11 items-center justify-center rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700">
                打开源管理
              </Link>
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
              {[
                { icon: RefreshCw, title: '实时导入', desc: folders.some((path) => path.enabled) ? '已启用监控文件夹实时导入。' : '未启用监控文件夹。' },
                { icon: Database, title: '监控根目录', desc: health?.checks.find((check) => check.name === 'monitorRootReadable')?.message ?? '待检测' },
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

function ScanRuleEditor({ path, saving, onSave }: { path: MonitorFolder; saving: boolean; onSave: (path: MonitorFolder, updates: Pick<MonitorFolder, 'importMode' | 'ignorePatterns' | 'ignoreHidden' | 'minFileSizeBytes'>) => Promise<void> }) {
  const [patterns, setPatterns] = useState(path.ignorePatterns ?? '');
  const [hidden, setHidden] = useState(path.ignoreHidden);
  const [minSizeKb, setMinSizeKb] = useState(String(Math.round((path.minFileSizeBytes ?? 0) / 1024)));
  const [mode, setMode] = useState<'COPY' | 'MOVE'>(path.importMode ?? 'COPY');

  useEffect(() => {
    setPatterns(path.ignorePatterns ?? '');
    setHidden(path.ignoreHidden);
    setMinSizeKb(String(Math.round((path.minFileSizeBytes ?? 0) / 1024)));
    setMode(path.importMode ?? 'COPY');
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
        添加模式
        <Select value={mode} options={importModeOptions} onChange={(value) => setMode(value as 'COPY' | 'MOVE')} ariaLabel="添加模式" className="mt-2 w-full max-w-xs" />
      </label>
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
        <Button type="button" icon={CheckCircle2} loading={saving} loadingText="保存中" onClick={() => onSave(path, { importMode: mode, ignorePatterns: patterns, ignoreHidden: hidden, minFileSizeBytes: Math.max(0, Math.round(Number(minSizeKb || 0) * 1024)) })}>保存规则</Button>
      </div>
    </div>
  );
}

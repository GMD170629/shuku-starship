'use client';

import { CheckCircle2, ChevronDown, ChevronRight, Database, Download, FolderOpen, RotateCcw, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
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
  ignorePatterns?: string | null;
  ignoreHidden: boolean;
  minFileSizeBytes: number;
  description?: string | null;
};

type MonitorFoldersPayload = {
  folders: MonitorFolder[];
  monitorRoot?: string;
  defaultUploadFolderId?: string | null;
  defaultDownloadFolderId?: string | null;
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

type DirectoryNode = {
  name: string;
  path: string;
  readable: boolean;
  error?: string | null;
  children: Array<{
    name: string;
    path: string;
    readable: boolean;
  }>;
};

type DirectoryTreePayload = {
  node: DirectoryNode;
  monitorRoot?: string | null;
};

type AppSettings = {
  systemName: string;
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

const editableSystemSettingKeys = new Set([
  'systemName',
  'library.defaultUploadFolderId',
  'library.defaultDownloadFolderId',
  'metadata.external.enabled',
  'metadata.douban.enabled',
  'metadata.douban.mode',
  'metadata.douban.baseUrl',
  'metadata.douban.apiKey',
  'metadata.douban.userAgent',
  'metadata.bangumi.enabled',
  'metadata.bangumi.baseUrl',
  'metadata.bangumi.accessToken',
  'metadata.bangumi.userAgent',
  'metadata.ai.enabled',
  'metadata.ai.baseUrl',
  'metadata.ai.apiKey',
  'metadata.ai.model',
  'download.qbittorrent.url',
  'download.qbittorrent.username',
  'download.qbittorrent.password',
  'download.qbittorrent.category',
  'download.qbittorrent.savePath'
]);

function settingsForSave(settings: AppSettings) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!editableSystemSettingKeys.has(key)) continue;
    if (key === 'download.qbittorrent.password' && !value.trim()) continue;
    next[key] = value;
  }
  return next;
}

export function SettingsPage() {
  const groups = ['基础设置', '监控文件夹', '备份与恢复', '元数据', '下载设置', '源管理'];
  const [active, setActive] = useState('基础设置');
  const [folders, setFolders] = useState<MonitorFolder[]>([]);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    systemName: '书库星舰',
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
    'metadata.ai.model': '',
    'library.defaultUploadFolderId': '',
    'library.defaultDownloadFolderId': '',
    'download.qbittorrent.url': '',
    'download.qbittorrent.username': '',
    'download.qbittorrent.password': '',
    'download.qbittorrent.category': '',
    'download.qbittorrent.savePath': ''
  });
  const [name, setName] = useState('我的监控文件夹');
  const [rootPath, setRootPath] = useState('/books');
  const [ignorePatterns, setIgnorePatterns] = useState('');
  const [ignoreHidden, setIgnoreHidden] = useState(true);
  const [minFileSizeKb, setMinFileSizeKb] = useState('0');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [backupBusy, setBackupBusy] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [pathBusy, setPathBusy] = useState('');
  const [ruleBusy, setRuleBusy] = useState('');
  const [expandedRules, setExpandedRules] = useState<Record<string, boolean>>({});
  const confirm = useConfirm();
  const toast = useToast();

  async function loadPaths() {
    const response = await fetch('/api/monitor-folders');
    const payload = (await response.json()) as { ok: boolean; data?: MonitorFoldersPayload; error?: { message: string } };
    if (payload.ok) {
      setFolders(payload.data?.folders ?? []);
      if (payload.data?.monitorRoot && rootPath === '/books') setRootPath(payload.data.monitorRoot);
      setSettings((current) => ({
        ...current,
        'library.defaultUploadFolderId': current['library.defaultUploadFolderId'] || payload.data?.defaultUploadFolderId || '',
        'library.defaultDownloadFolderId': current['library.defaultDownloadFolderId'] || payload.data?.defaultDownloadFolderId || ''
      }));
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
    if (active === '监控规则') setActive('监控文件夹');
  }, [active]);

  useEffect(() => {
    loadPaths();
    loadBackups();
    fetch('/api/system-settings').then((response) => response.json()).then((payload) => {
      if (!payload.ok) return;
      const loaded = { ...payload.data.settings } as Record<string, unknown>;
      const passwordConfigured = typeof loaded['download.qbittorrent.password'] === 'string' && loaded['download.qbittorrent.password'].trim().length > 0;
      delete loaded.theme;
      delete loaded.timezone;
      delete loaded.language;
      delete loaded['download.qbittorrent.password'];
      setSettings((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')])),
        'download.qbittorrent.password': '',
        'download.qbittorrent.passwordConfigured': String(passwordConfigured)
      }));
    }).catch(() => undefined);
  }, []);

  async function savePath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setPathBusy('create');
    const response = await fetch('/api/monitor-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rootPath, enabled: true, ignorePatterns, ignoreHidden, minFileSizeBytes: Math.max(0, Math.round(Number(minFileSizeKb || 0) * 1024)) })
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

  async function saveScanRules(path: MonitorFolder, updates: Pick<MonitorFolder, 'ignorePatterns' | 'ignoreHidden' | 'minFileSizeBytes'>) {
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
    const settingsToSave = settingsForSave(hasCompleteAiSettings(settings)
      ? { ...settings, 'metadata.ai.enabled': 'true' }
      : settings);
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
      setSettings((current) => ({
        ...current,
        ...settingsToSave,
        'download.qbittorrent.password': '',
        'download.qbittorrent.passwordConfigured': settingsToSave['download.qbittorrent.password'] ? 'true' : current['download.qbittorrent.passwordConfigured'] ?? 'false'
      }));
      setMessage('系统设置已保存');
      toast.success('系统设置已保存');
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="系统设置" desc="配置系统名称、监控导入、备份、元数据、下载和来源。" action={<Button icon={CheckCircle2} loading={settingsBusy} loadingText="保存中" onClick={saveSettings}>保存设置</Button>} />
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
              {message ? <div className="md:col-span-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
              {error ? <div className="md:col-span-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
            </div>
          ) : active === '监控文件夹' ? (
            <div className="mt-6 space-y-5">
              <form onSubmit={savePath} className="grid grid-cols-1 gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:grid-cols-12">
                <label className="md:col-span-3">
                  <span className="text-sm font-medium text-slate-700">名称</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none" />
                </label>
                <div className="md:col-span-9">
                  <span className="text-sm font-medium text-slate-700">监控文件夹路径</span>
                  <DirectoryPathPicker value={rootPath} onChange={setRootPath} />
                </div>
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
                  <div key={path.id} className="rounded-3xl border border-slate-200 bg-white p-5">
                    <div className="flex flex-col gap-4 md:flex-row md:items-center">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                        <FolderOpen size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold">{path.name}</div>
                        <div className="break-words text-sm text-slate-500">{path.rootPath}</div>
                        <div className="mt-2 text-xs text-slate-500">引用原文件 · {path.ignoreHidden ? '忽略隐藏文件' : '包含隐藏文件'} · 小于 {Math.round((path.minFileSizeBytes ?? 0) / 1024)} KB 跳过 · {path.ignorePatterns?.trim() ? '已配置自定义忽略规则' : '仅默认忽略规则'}</div>
                      </div>
                      <button disabled={pathBusy === `toggle:${path.id}`} onClick={() => togglePath(path)} className={cn('h-7 w-12 rounded-full p-1 transition disabled:cursor-not-allowed disabled:opacity-60', path.enabled ? 'bg-blue-600' : 'bg-slate-300')} aria-label="启用监控文件夹">
                        <span className={cn('block h-5 w-5 rounded-full bg-white transition', path.enabled && 'translate-x-5')} />
                      </button>
                      <Button
                        type="button"
                        variant="secondary"
                        icon={ChevronDown}
                        onClick={() => setExpandedRules((current) => ({ ...current, [path.id]: !current[path.id] }))}
                        aria-expanded={Boolean(expandedRules[path.id])}
                      >
                        规则
                      </Button>
                      <Button variant="danger" icon={Trash2} loading={pathBusy === `delete:${path.id}`} loadingText="删除中" onClick={() => deletePath(path)}>删除</Button>
                    </div>
                    {expandedRules[path.id] ? (
                      <div className="mt-4 border-t border-slate-100 pt-4">
                        <ScanRuleEditor path={path} saving={ruleBusy === path.id} onSave={saveScanRules} compact />
                      </div>
                    ) : null}
                  </div>
                ))}
                {folders.length === 0 ? <div className="rounded-3xl bg-slate-50 p-6 text-sm text-slate-500">尚未保存监控文件夹。</div> : null}
              </div>
              <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <div className="font-semibold text-slate-950">默认投递目录</div>
                <div className="mt-1 text-sm text-slate-500">上传和下载只会保存到这里选择的监控文件夹，随后由监控服务自动识别入库。</div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="text-sm text-slate-600">
                    默认上传目录
                    <Select
                      value={settings['library.defaultUploadFolderId'] || ''}
                      options={[{ value: '', label: '请选择监控文件夹' }, ...folders.filter((folder) => folder.enabled).map((folder) => ({ value: folder.id, label: folder.name }))]}
                      onChange={(value) => setSettings({ ...settings, 'library.defaultUploadFolderId': value })}
                      ariaLabel="默认上传目录"
                      className="mt-2 w-full"
                    />
                  </label>
                  <label className="text-sm text-slate-600">
                    默认下载目录
                    <Select
                      value={settings['library.defaultDownloadFolderId'] || ''}
                      options={[{ value: '', label: '请选择监控文件夹' }, ...folders.filter((folder) => folder.enabled).map((folder) => ({ value: folder.id, label: folder.name }))]}
                      onChange={(value) => setSettings({ ...settings, 'library.defaultDownloadFolderId': value })}
                      ariaLabel="默认下载目录"
                      className="mt-2 w-full"
                    />
                  </label>
                </div>
              </section>
            </div>
          ) : active === '备份与恢复' ? (
            <div className="mt-6 space-y-5">
              <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="font-semibold">备份范围</div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">仅包含系统设置和数据库数据，包括读物元数据、标签、阅读进度、监控文件夹配置和封面缓存索引；不包含原始读物文件或封面图片文件。</div>
                  <div className="mt-2 text-xs text-slate-500">当前支持手动备份；恢复备份会覆盖数据库中的相关记录。</div>
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
          ) : active === '下载设置' ? (
            <div className="mt-6 space-y-5">
              <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <div className="font-semibold">qBittorrent</div>
                <div className="mt-1 text-sm leading-6 text-slate-500">配置后，torrent 和 magnet 下载任务会提交到 qBittorrent；未配置时仍使用本地下载收件箱交接。</div>
                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  <label className="text-sm text-slate-600">
                    Web API 地址
                    <input value={settings['download.qbittorrent.url']} onChange={(event) => setSettings({ ...settings, 'download.qbittorrent.url': event.target.value })} placeholder="http://qbittorrent:8080" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none" />
                  </label>
                  <label className="text-sm text-slate-600">
                    用户名
                    <input value={settings['download.qbittorrent.username']} onChange={(event) => setSettings({ ...settings, 'download.qbittorrent.username': event.target.value })} placeholder="admin" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none" />
                  </label>
                  <label className="text-sm text-slate-600">
                    密码
                    <input
                      type="password"
                      value={settings['download.qbittorrent.password']}
                      onChange={(event) => setSettings({ ...settings, 'download.qbittorrent.password': event.target.value })}
                      placeholder={settings['download.qbittorrent.passwordConfigured'] === 'true' ? '已配置；留空则保留原密码' : 'qBittorrent 密码'}
                      className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none"
                    />
                  </label>
                  <label className="text-sm text-slate-600">
                    分类
                    <input value={settings['download.qbittorrent.category']} onChange={(event) => setSettings({ ...settings, 'download.qbittorrent.category': event.target.value })} placeholder="shuku" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none" />
                  </label>
                  <label className="text-sm text-slate-600 md:col-span-2">
                    保存路径
                    <input value={settings['download.qbittorrent.savePath']} onChange={(event) => setSettings({ ...settings, 'download.qbittorrent.savePath': event.target.value })} placeholder="/downloads/books" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none" />
                  </label>
                </div>
              </section>
              {message ? <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
              {error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
            </div>
          ) : active === '源管理' ? (
            <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <div className="font-semibold">通用来源配置</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">集中管理手动源、PT RSS、Z-Library、漫画 API、通用 RSS 和 HTTP 源。可保存账号与连接信息，并用于搜索和下载。</div>
              <Link href="/settings/sources" className="mt-4 inline-flex min-h-11 items-center justify-center rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700">
                打开源管理
              </Link>
            </div>
          ) : (
            null
          )}
        </div>
      </div>
    </div>
  );
}

function DirectoryPathPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [monitorRoot, setMonitorRoot] = useState('');
  const [nodes, setNodes] = useState<Record<string, DirectoryNode>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingPath, setLoadingPath] = useState('');
  const [treeError, setTreeError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  async function loadNode(path?: string) {
    setLoadingPath(path || '__root__');
    setTreeError('');
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const response = await fetch(`/api/monitor-folders/tree${query}`);
      const payload = (await response.json()) as { ok: boolean; data?: DirectoryTreePayload; error?: { message: string } };
      if (!payload.ok || !payload.data?.node) {
        setTreeError(payload.error?.message ?? '读取目录树失败');
        return null;
      }
      const node = payload.data.node;
      setMonitorRoot(payload.data.monitorRoot || node.path);
      setNodes((current) => ({ ...current, [node.path]: node }));
      return node;
    } catch {
      setTreeError('读取目录树失败');
      return null;
    } finally {
      setLoadingPath('');
    }
  }

  useEffect(() => {
    loadNode();
  }, []);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [open]);

  async function toggleDirectory(path: string) {
    const nextExpanded = !expanded[path];
    setExpanded((current) => ({ ...current, [path]: nextExpanded }));
    if (nextExpanded && !nodes[path]) await loadNode(path);
  }

  function selectPath(path: string) {
    onChange(path);
    setOpen(false);
  }

  const rootNode = monitorRoot ? nodes[monitorRoot] : Object.values(nodes)[0];

  return (
    <div ref={rootRef} className="relative mt-2">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
          aria-expanded={open}
        >
          <FolderOpen size={16} />
          选择
          <ChevronDown size={16} className={cn('transition', open && 'rotate-180')} />
        </button>
      </div>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-xl shadow-slate-200/60">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-slate-950">监控根目录</div>
              <div className="truncate text-xs text-slate-500">{monitorRoot || '读取中'}</div>
            </div>
            <button
              type="button"
              onClick={() => loadNode(value || monitorRoot || undefined)}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <RotateCcw size={14} />
              刷新
            </button>
          </div>
          <div className="max-h-72 overflow-auto rounded-xl bg-slate-50 p-2">
            {rootNode ? (
              <DirectoryNodeRow
                node={rootNode}
                level={0}
                selectedPath={value}
                nodes={nodes}
                expanded={expanded}
                loadingPath={loadingPath}
                onSelect={selectPath}
                onToggle={toggleDirectory}
              />
            ) : (
              <div className="px-3 py-2 text-slate-500">{loadingPath ? '正在读取目录...' : '暂无可选目录'}</div>
            )}
          </div>
          {treeError ? <div className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{treeError}</div> : null}
          <div className="mt-2 text-xs leading-5 text-slate-500">只能浏览监控根目录内的目录；也可以直接粘贴路径。</div>
        </div>
      ) : null}
    </div>
  );
}

function DirectoryNodeRow({
  node,
  level,
  selectedPath,
  nodes,
  expanded,
  loadingPath,
  onSelect,
  onToggle
}: {
  node: DirectoryNode;
  level: number;
  selectedPath: string;
  nodes: Record<string, DirectoryNode>;
  expanded: Record<string, boolean>;
  loadingPath: string;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const isExpanded = Boolean(expanded[node.path]);
  const isSelected = selectedPath === node.path;
  const children = node.children ?? [];

  return (
    <div>
      <div className={cn('flex items-center gap-1 rounded-xl px-2 py-1.5', isSelected ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-white')} style={{ paddingLeft: `${8 + level * 18}px` }}>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
          aria-label={isExpanded ? '收起目录' : '展开目录'}
        >
          <ChevronRight size={15} className={cn('transition', isExpanded && 'rotate-90')} />
        </button>
        <button type="button" onClick={() => onSelect(node.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <FolderOpen size={15} className="shrink-0" />
          <span className="truncate">{node.name || node.path}</span>
        </button>
        {loadingPath === node.path ? <span className="text-xs text-slate-400">读取中</span> : null}
      </div>
      {isExpanded ? (
        <div>
          {children.length > 0 ? children.map((child) => {
            const childNode = nodes[child.path] ?? { ...child, children: [] };
            return (
              <DirectoryNodeRow
                key={child.path}
                node={childNode}
                level={level + 1}
                selectedPath={selectedPath}
                nodes={nodes}
                expanded={expanded}
                loadingPath={loadingPath}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            );
          }) : <div className="px-3 py-1.5 text-xs text-slate-400" style={{ paddingLeft: `${42 + level * 18}px` }}>没有子目录</div>}
        </div>
      ) : null}
    </div>
  );
}

function ScanRuleEditor({ path, saving, onSave, compact = false }: { path: MonitorFolder; saving: boolean; onSave: (path: MonitorFolder, updates: Pick<MonitorFolder, 'ignorePatterns' | 'ignoreHidden' | 'minFileSizeBytes'>) => Promise<void>; compact?: boolean }) {
  const [patterns, setPatterns] = useState(path.ignorePatterns ?? '');
  const [hidden, setHidden] = useState(path.ignoreHidden);
  const [minSizeKb, setMinSizeKb] = useState(String(Math.round((path.minFileSizeBytes ?? 0) / 1024)));

  useEffect(() => {
    setPatterns(path.ignorePatterns ?? '');
    setHidden(path.ignoreHidden);
    setMinSizeKb(String(Math.round((path.minFileSizeBytes ?? 0) / 1024)));
  }, [path]);

  return (
    <div className={cn(!compact && 'rounded-3xl border border-slate-200 bg-slate-50 p-5')}>
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
        <Button type="button" icon={CheckCircle2} loading={saving} loadingText="保存中" onClick={() => onSave(path, { ignorePatterns: patterns, ignoreHidden: hidden, minFileSizeBytes: Math.max(0, Math.round(Number(minSizeKb || 0) * 1024)) })}>保存规则</Button>
      </div>
    </div>
  );
}

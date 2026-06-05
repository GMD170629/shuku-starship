'use client';

import { AlertTriangle, CheckCircle2, Database, Edit3, FlaskConical, Plus, Save, Settings, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';

type SourceProviderType = 'manual' | 'telegram' | 'pt_rss' | 'comic_api' | 'rss' | 'http';
type SourceKind = 'novel' | 'comic' | 'mixed' | 'metadata';
type SourceView = {
  id: string;
  name: string;
  kind: SourceKind;
  kindLabel: string;
  providerType: SourceProviderType;
  providerTypeLabel: string;
  enabled: boolean;
  priority: number;
  config: unknown;
  capabilities: unknown;
  rateLimit: unknown;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type SourcesPayload = { ok: boolean; data?: { sources: SourceView[] }; error?: { message: string } };
type SourceTestPreview = { title: string; publishedAt?: string | null; category?: string | null };
type SourcePayload = { ok: boolean; data?: { source: SourceView; result?: { status: string; message: string; details?: { preview?: SourceTestPreview[] } } }; error?: { message: string } };

const providerOptions = [
  { value: 'manual', label: '手动源' },
  { value: 'telegram', label: 'Z-Library Telegram Bot' },
  { value: 'pt_rss', label: 'PT RSS 源' },
  { value: 'comic_api', label: '漫画 API 源' },
  { value: 'rss', label: '通用 RSS 源' },
  { value: 'http', label: '通用 HTTP 源' }
];

const kindOptions = [
  { value: 'novel', label: '小说' },
  { value: 'comic', label: '漫画' },
  { value: 'mixed', label: '混合' },
  { value: 'metadata', label: '元数据' }
];

const defaultConfig: Record<SourceProviderType, unknown> = {
  manual: { note: '手动维护的来源' },
  telegram: { botUsername: '', mode: 'zlibrary_bot', gatewayUrl: '', searchCommand: '/search', resultParseMode: 'zlibrary_text', downloadEnabled: false, cooldown: 0 },
  pt_rss: { rssUrl: '', keywordInclude: [], keywordExclude: [], category: '', defaultType: 'comic', cooldown: 0 },
  comic_api: { baseUrl: '', apiKey: '' },
  rss: { url: '', rssKey: '' },
  http: {
    items: [
      {
        externalId: 'http-demo-1',
        title: 'HTTP 测试 EPUB',
        format: 'epub',
        downloadUrl: 'https://example.com/book.epub',
        size: '1MB'
      }
    ]
  }
};

const telegramCapabilities = { search: true, download: false, telegram: true, requiresAuth: true };
const ptRssCapabilities = { search: true, download: false, rss: true, torrent: true, requiresAuth: true };
const telegramModeOptions = [
  { value: 'zlibrary_bot', label: 'Z-Library Bot' },
  { value: 'gateway', label: '自建 Gateway' }
];

type TelegramForm = {
  botUsername: string;
  mode: 'zlibrary_bot' | 'gateway';
  gatewayUrl: string;
  searchCommand: string;
  resultParseMode: string;
  downloadEnabled: boolean;
  cooldown: string;
};

type PtRssForm = {
  rssUrl: string;
  rssUrlConfigured: boolean;
  keywordInclude: string;
  keywordExclude: string;
  category: string;
  cooldown: string;
};

function stringifyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonInput(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
}

function formatDateTime(value: string | null) {
  if (!value) return '未测试';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未测试' : date.toLocaleString();
}

function maskedText(value: unknown): string | null {
  if (value && typeof value === 'object' && (value as { configured?: unknown }).configured === true) {
    return String((value as { masked?: unknown }).masked ?? '已配置');
  }
  return null;
}

function plainObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function telegramFormFromConfig(value: unknown): TelegramForm {
  const config = plainObject(value);
  const mode = config.mode === 'gateway' ? 'gateway' : 'zlibrary_bot';
  return {
    botUsername: typeof config.botUsername === 'string' ? config.botUsername : '',
    mode,
    gatewayUrl: typeof config.gatewayUrl === 'string' ? config.gatewayUrl : '',
    searchCommand: typeof config.searchCommand === 'string' ? config.searchCommand : '',
    resultParseMode: typeof config.resultParseMode === 'string' ? config.resultParseMode : '',
    downloadEnabled: config.downloadEnabled === true,
    cooldown: config.cooldown === undefined || config.cooldown === null ? '0' : String(config.cooldown)
  };
}

function telegramConfigFromForm(form: TelegramForm, current?: unknown) {
  const cooldown = Number(form.cooldown || 0);
  return {
    ...plainObject(current),
    botUsername: form.botUsername.trim() || undefined,
    mode: form.mode,
    gatewayUrl: form.gatewayUrl.trim() || undefined,
    searchCommand: form.searchCommand.trim() || '/search',
    resultParseMode: form.resultParseMode.trim() || 'zlibrary_text',
    downloadEnabled: form.downloadEnabled,
    cooldown: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 0
  };
}

function commaList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : '';
}

function parseCommaList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function ptRssFormFromConfig(value: unknown): PtRssForm {
  const config = plainObject(value);
  const maskedRssUrl = maskedText(config.rssUrl);
  const legacyMaskedUrl = maskedText(config.url);
  return {
    rssUrl: typeof config.rssUrl === 'string' ? config.rssUrl : typeof config.url === 'string' ? config.url : '',
    rssUrlConfigured: Boolean(maskedRssUrl || legacyMaskedUrl),
    keywordInclude: commaList(config.keywordInclude),
    keywordExclude: commaList(config.keywordExclude),
    category: typeof config.category === 'string' ? config.category : '',
    cooldown: config.cooldown === undefined || config.cooldown === null ? '0' : String(config.cooldown)
  };
}

function ptRssConfigFromForm(form: PtRssForm, current?: unknown) {
  const currentObject = plainObject(current);
  const cooldown = Number(form.cooldown || 0);
  const next: Record<string, unknown> = {
    ...currentObject,
    keywordInclude: parseCommaList(form.keywordInclude),
    keywordExclude: parseCommaList(form.keywordExclude),
    category: form.category.trim() || undefined,
    defaultType: 'comic',
    cooldown: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 0
  };
  if (form.rssUrl.trim()) {
    next.rssUrl = form.rssUrl.trim();
    delete next.url;
  } else if (!form.rssUrlConfigured) {
    next.rssUrl = '';
    delete next.url;
  }
  return next;
}

function SensitiveSummary({ value }: { value: unknown }) {
  const items = useMemo(() => {
    const found: Array<{ path: string; text: string }> = [];
    function walk(current: unknown, path: string) {
      const text = maskedText(current);
      if (text) {
        found.push({ path, text });
        return;
      }
      if (Array.isArray(current)) current.forEach((item, index) => walk(item, `${path}[${index}]`));
      else if (current && typeof current === 'object') Object.entries(current as Record<string, unknown>).forEach(([key, item]) => walk(item, path ? `${path}.${key}` : key));
    }
    walk(value, '');
    return found;
  }, [value]);
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.slice(0, 4).map((item) => (
        <span key={item.path} className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{item.path}: {item.text}</span>
      ))}
    </div>
  );
}

export function SourcesPage() {
  const [sources, setSources] = useState<SourceView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('手动源');
  const [providerType, setProviderType] = useState<SourceProviderType>('manual');
  const [kind, setKind] = useState<SourceKind>('mixed');
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState('100');
  const [configText, setConfigText] = useState(stringifyJson(defaultConfig.manual));
  const [capabilitiesText, setCapabilitiesText] = useState('{}');
  const [rateLimitText, setRateLimitText] = useState('{}');
  const [telegramForm, setTelegramForm] = useState<TelegramForm>(telegramFormFromConfig(defaultConfig.telegram));
  const [ptRssForm, setPtRssForm] = useState<PtRssForm>(ptRssFormFromConfig(defaultConfig.pt_rss));
  const [rssPreview, setRssPreview] = useState<SourceTestPreview[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const editingSource = sources.find((source) => source.id === selectedId) ?? null;

  async function loadSources() {
    const response = await fetch('/api/sources');
    const payload = (await response.json()) as SourcesPayload;
    if (!payload.ok) {
      setError(payload.error?.message ?? '读取源列表失败');
      return;
    }
    setSources(payload.data?.sources ?? []);
  }

  useEffect(() => {
    void loadSources();
  }, []);

  function resetForm(nextProvider: SourceProviderType = 'manual') {
    setSelectedId(null);
    setName(nextProvider === 'manual' ? '手动源' : providerOptions.find((option) => option.value === nextProvider)?.label ?? '新源');
    setProviderType(nextProvider);
    setKind(nextProvider === 'comic_api' || nextProvider === 'pt_rss' ? 'comic' : nextProvider === 'telegram' ? 'novel' : 'mixed');
    setEnabled(true);
    setPriority('100');
    setConfigText(stringifyJson(defaultConfig[nextProvider]));
    setCapabilitiesText(nextProvider === 'telegram' ? stringifyJson(telegramCapabilities) : nextProvider === 'pt_rss' ? stringifyJson(ptRssCapabilities) : '{}');
    setRateLimitText('{}');
    setTelegramForm(telegramFormFromConfig(defaultConfig[nextProvider]));
    setPtRssForm(ptRssFormFromConfig(defaultConfig[nextProvider]));
    setRssPreview([]);
    setError('');
    setMessage('');
  }

  function editSource(source: SourceView) {
    setSelectedId(source.id);
    setName(source.name);
    setProviderType(source.providerType);
    setKind(source.kind);
    setEnabled(source.enabled);
    setPriority(String(source.priority));
    setConfigText(stringifyJson(source.config));
    setCapabilitiesText(stringifyJson(source.capabilities));
    setRateLimitText(stringifyJson(source.rateLimit));
    setTelegramForm(telegramFormFromConfig(source.config));
    setPtRssForm(ptRssFormFromConfig(source.config));
    setRssPreview([]);
    setError('');
    setMessage('');
  }

  async function saveSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('save');
    setError('');
    setMessage('');
    try {
      const body = {
        name,
        providerType,
        kind,
        enabled,
        priority,
        config: providerType === 'telegram'
          ? telegramConfigFromForm(telegramForm, editingSource?.config)
          : providerType === 'pt_rss'
            ? ptRssConfigFromForm(ptRssForm, editingSource?.config)
            : parseJsonInput(configText, '配置'),
        capabilities: providerType === 'telegram' ? telegramCapabilities : providerType === 'pt_rss' ? ptRssCapabilities : parseJsonInput(capabilitiesText, '能力'),
        rateLimit: parseJsonInput(rateLimitText, '限流')
      };
      const response = await fetch(selectedId ? `/api/sources/${selectedId}` : '/api/sources', {
        method: selectedId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = (await response.json()) as SourcePayload;
      if (!payload.ok || !payload.data?.source) throw new Error(payload.error?.message ?? '保存源失败');
      setMessage(selectedId ? '源已更新' : '源已创建');
      setSelectedId(payload.data.source.id);
      await loadSources();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存源失败');
    } finally {
      setBusy('');
    }
  }

  async function updateSource(source: SourceView, updates: Partial<Pick<SourceView, 'enabled' | 'priority'>>) {
    setBusy(source.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/sources/${source.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const payload = (await response.json()) as SourcePayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '更新源失败');
      setMessage('源已更新');
      await loadSources();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新源失败');
    } finally {
      setBusy('');
    }
  }

  async function testSource(source: SourceView) {
    setBusy(`test:${source.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/sources/${source.id}/test`, { method: 'POST' });
      const payload = (await response.json()) as SourcePayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '测试失败');
      setMessage(payload.data?.result?.message ?? '测试完成');
      setRssPreview(payload.data?.result?.details?.preview ?? []);
      await loadSources();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '测试失败');
    } finally {
      setBusy('');
    }
  }

  async function deleteSource(source: SourceView) {
    if (!window.confirm(`删除源「${source.name}」？如果未来已有绑定，系统会改为禁用。`)) return;
    setBusy(`delete:${source.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/sources/${source.id}`, { method: 'DELETE' });
      const payload = (await response.json()) as { ok: boolean; data?: { deleted?: boolean; disabled?: boolean }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '删除源失败');
      setMessage(payload.data?.disabled ? '源已有绑定，已改为禁用' : '源已删除');
      if (selectedId === source.id) resetForm();
      await loadSources();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除源失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="源管理"
        desc="管理小说源、漫画源、PT RSS、Z-Library Telegram Bot、RSS 与 HTTP 等通用来源。"
        action={<Link href="/settings" className="inline-flex min-h-11 items-center rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">返回系统设置</Link>}
      />
      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">源列表</h2>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={Plus} onClick={() => resetForm('manual')}>手动源</Button>
              <Button variant="secondary" icon={Plus} onClick={() => resetForm('pt_rss')}>PT RSS</Button>
              <Button variant="secondary" icon={Plus} onClick={() => resetForm('telegram')}>Z-Library Bot</Button>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {sources.map((source) => (
              <div key={source.id} className={cn('rounded-2xl border p-4', selectedId === source.id ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200 bg-white')}>
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate font-medium text-slate-900">{source.name}</div>
                      <span className={cn('rounded-full px-2 py-1 text-xs', source.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{source.enabled ? '已启用' : '已禁用'}</span>
                      <span className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">{source.providerTypeLabel}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{source.kindLabel}</span>
                    </div>
                    <div className="mt-2 text-sm text-slate-500">优先级 {source.priority} · 最近测试 {formatDateTime(source.lastTestAt)}</div>
                    <SensitiveSummary value={source.config} />
                    {source.lastError ? <div className="mt-2 flex items-center gap-1 text-sm text-red-600"><AlertTriangle size={14} />{source.lastError}</div> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" icon={Edit3} onClick={() => editSource(source)}>编辑</Button>
                    <Button disabled={busy === source.id} variant="secondary" icon={source.enabled ? CheckCircle2 : Database} onClick={() => updateSource(source, { enabled: !source.enabled })}>{source.enabled ? '禁用' : '启用'}</Button>
                    <Button disabled={busy === `test:${source.id}`} variant="secondary" icon={FlaskConical} onClick={() => void testSource(source)}>测试</Button>
                    <Button disabled={busy === `delete:${source.id}`} variant="danger" icon={Trash2} onClick={() => void deleteSource(source)}>删除</Button>
                  </div>
                </div>
              </div>
            ))}
            {sources.length === 0 ? <div className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">暂无源。可以先新增手动源、PT RSS 源或 Z-Library Telegram Bot。</div> : null}
          </div>
        </div>
        <form onSubmit={saveSource} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Settings size={18} className="text-slate-500" />
            <h2 className="text-lg font-semibold">{editingSource ? '编辑源' : '新增源'}</h2>
          </div>
          <div className="mt-4 space-y-4">
            <label className="block text-sm text-slate-600">
              源名称
              <input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="block text-sm text-slate-600">
              源类型
              <Select
                value={providerType}
                options={providerOptions}
                onChange={(value) => {
                  setProviderType(value);
                  if (!selectedId) {
                    setConfigText(stringifyJson(defaultConfig[value]));
                    setCapabilitiesText(value === 'telegram' ? stringifyJson(telegramCapabilities) : value === 'pt_rss' ? stringifyJson(ptRssCapabilities) : '{}');
                    setTelegramForm(telegramFormFromConfig(defaultConfig[value]));
                    setPtRssForm(ptRssFormFromConfig(defaultConfig[value]));
                  }
                }}
                ariaLabel="源类型"
                className="mt-2 w-full"
              />
            </label>
            <label className="block text-sm text-slate-600">
              内容类型
              <Select value={kind} options={kindOptions} onChange={setKind} ariaLabel="内容类型" className="mt-2 w-full" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-slate-600">
                优先级
                <input value={priority} onChange={(event) => setPriority(event.target.value)} type="number" min="0" max="9999" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
              </label>
              <label className="flex items-center gap-2 pt-7 text-sm text-slate-600">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 accent-blue-600" />
                启用
              </label>
            </div>
            {providerType === 'pt_rss' ? (
              <div className="space-y-4 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4">
                <div className="text-sm font-medium text-slate-900">PT RSS 漫画源配置</div>
                <label className="block text-sm text-slate-600">
                  RSS URL
                  <input
                    value={ptRssForm.rssUrl}
                    onChange={(event) => setPtRssForm({ ...ptRssForm, rssUrl: event.target.value, rssUrlConfigured: ptRssForm.rssUrlConfigured && !event.target.value ? true : ptRssForm.rssUrlConfigured })}
                    placeholder={ptRssForm.rssUrlConfigured ? 'RSS URL 已配置；留空则保留原值' : '粘贴你的 PT RSS URL'}
                    className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300"
                  />
                </label>
                <label className="block text-sm text-slate-600">
                  包含关键词
                  <input value={ptRssForm.keywordInclude} onChange={(event) => setPtRssForm({ ...ptRssForm, keywordInclude: event.target.value })} placeholder="多个关键词用英文逗号分隔" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                </label>
                <label className="block text-sm text-slate-600">
                  排除关键词
                  <input value={ptRssForm.keywordExclude} onChange={(event) => setPtRssForm({ ...ptRssForm, keywordExclude: event.target.value })} placeholder="多个关键词用英文逗号分隔" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                </label>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="text-sm text-slate-600">
                    分类
                    <input value={ptRssForm.category} onChange={(event) => setPtRssForm({ ...ptRssForm, category: event.target.value })} placeholder="可选" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                  </label>
                  <label className="text-sm text-slate-600">
                    冷却时间（秒）
                    <input value={ptRssForm.cooldown} onChange={(event) => setPtRssForm({ ...ptRssForm, cooldown: event.target.value })} type="number" min="0" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                  </label>
                </div>
                <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                  手动搜索会临时拉取 RSS 并过滤标题；不会自动追更、不会启动 BT 客户端，也不会自动下载 torrent。
                </div>
                {rssPreview.length > 0 ? (
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <div className="text-sm font-medium text-slate-900">最近 5 条标题</div>
                    <div className="mt-2 space-y-1 text-sm text-slate-600">
                      {rssPreview.map((item, index) => (
                        <div key={`${item.title}-${index}`} className="break-words">{item.title}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {editingSource?.providerType === 'pt_rss' ? (
                  <Button type="button" disabled={busy === `test:${editingSource.id}`} variant="secondary" icon={FlaskConical} onClick={() => void testSource(editingSource)}>测试 RSS</Button>
                ) : null}
              </div>
            ) : providerType === 'telegram' ? (
              <div className="space-y-4 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
                <div className="text-sm font-medium text-slate-900">Z-Library Telegram Bot 配置</div>
                <label className="block text-sm text-slate-600">
                  Bot 用户名
                  <input value={telegramForm.botUsername} onChange={(event) => setTelegramForm({ ...telegramForm, botUsername: event.target.value })} placeholder="例如 @your_zlibrary_bot" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                </label>
                <label className="block text-sm text-slate-600">
                  模式
                  <Select value={telegramForm.mode} options={telegramModeOptions} onChange={(mode) => setTelegramForm({ ...telegramForm, mode })} ariaLabel="Telegram 模式" className="mt-2 w-full bg-white" />
                </label>
                <label className="block text-sm text-slate-600">
                  Gateway URL
                  <input value={telegramForm.gatewayUrl} onChange={(event) => setTelegramForm({ ...telegramForm, gatewayUrl: event.target.value })} placeholder="可选：自建 Telegram 搜索网关 POST URL" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                </label>
                <label className="block text-sm text-slate-600">
                  搜索命令
                  <input value={telegramForm.searchCommand} onChange={(event) => setTelegramForm({ ...telegramForm, searchCommand: event.target.value })} placeholder="/search" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                </label>
                <label className="block text-sm text-slate-600">
                  结果解析模式
                  <input value={telegramForm.resultParseMode} onChange={(event) => setTelegramForm({ ...telegramForm, resultParseMode: event.target.value })} placeholder="例如 text、json、regex" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                </label>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex items-center gap-2 pt-2 text-sm text-slate-600">
                    <input type="checkbox" checked={telegramForm.downloadEnabled} onChange={(event) => setTelegramForm({ ...telegramForm, downloadEnabled: event.target.checked })} className="h-4 w-4 accent-blue-600" />
                    是否启用下载
                  </label>
                  <label className="text-sm text-slate-600">
                    冷却时间（秒）
                    <input value={telegramForm.cooldown} onChange={(event) => setTelegramForm({ ...telegramForm, cooldown: event.target.value })} type="number" min="0" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300" />
                  </label>
                </div>
                <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                  该源明确用于 Z-Library Telegram Bot。未配置 gateway 时会返回可点击的 Telegram handoff；配置 gateway 后会通过网关执行搜索。请只配置你有权使用的 Bot 或网关。
                </div>
              </div>
            ) : (
              <>
                <label className="block text-sm text-slate-600">
                  配置 JSON
                  <textarea value={configText} onChange={(event) => setConfigText(event.target.value)} rows={9} spellCheck={false} className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 font-mono text-xs text-slate-900 outline-none focus:border-blue-300" />
                </label>
                <label className="block text-sm text-slate-600">
                  能力 JSON
                  <textarea value={capabilitiesText} onChange={(event) => setCapabilitiesText(event.target.value)} rows={4} spellCheck={false} className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 font-mono text-xs text-slate-900 outline-none focus:border-blue-300" />
                </label>
              </>
            )}
            <label className="block text-sm text-slate-600">
              限流 JSON
              <textarea value={rateLimitText} onChange={(event) => setRateLimitText(event.target.value)} rows={4} spellCheck={false} className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 font-mono text-xs text-slate-900 outline-none focus:border-blue-300" />
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => resetForm()}>新建</Button>
            <Button disabled={busy === 'save'} icon={Save}>保存源</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

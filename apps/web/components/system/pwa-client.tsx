'use client';

import { Bug, Clipboard, Download, RefreshCw, Share, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clearPrivatePwaData, flushOfflineQueues } from '../../lib/pwa/progressQueue';
import { cn } from '../ui/cn';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const INSTALL_DISMISSED_KEY = 'shuku:pwa:install-dismissed';
const INSTALL_ACCEPTED_KEY = 'shuku:pwa:install-accepted';
const PWA_DEBUG_ENABLED_KEY = 'shuku:pwa:debug-enabled';

type DebugLevel = 'log' | 'info' | 'warn' | 'error';
type DebugLog = {
  id: number;
  level: DebugLevel;
  time: string;
  source: string;
  message: string;
};
type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

function isStandaloneDisplay() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

function isIosSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIos && isSafari;
}

function canShowInstallHint() {
  if (typeof window === 'undefined') return false;
  if (isStandaloneDisplay()) return false;
  return localStorage.getItem(INSTALL_ACCEPTED_KEY) !== '1' && localStorage.getItem(INSTALL_DISMISSED_KEY) !== '1';
}

function isNativeLikePwaSurface(pathname: string, search: string) {
  if (typeof window === 'undefined') return false;
  const pwaLaunch = new URLSearchParams(search).get('source') === 'pwa';
  return isStandaloneDisplay() || pwaLaunch || pathname === '/mobile' || pathname.startsWith('/reader/');
}

function isControlTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, label, [role="button"], [contenteditable="true"], [data-reader-control="true"]'));
}

export async function clearPrivatePwaStorage() {
  await clearPrivatePwaData();
}

export function PwaClient() {
  const pathname = usePathname();
  const [offline, setOffline] = useState(false);
  const [recentlyRestored, setRecentlyRestored] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [updateWorker, setUpdateWorker] = useState<ServiceWorker | null>(null);
  const refreshingRef = useRef(false);
  const restoreTimerRef = useRef<number | null>(null);
  const nativeLikeSurface = typeof window !== 'undefined' ? isNativeLikePwaSurface(pathname, window.location.search) : false;

  const showInstallPrompt = useMemo(() => Boolean(installEvent) || showIosHint, [installEvent, showIosHint]);

  useEffect(() => {
    setOffline(typeof navigator !== 'undefined' ? !navigator.onLine : false);
    setShowIosHint(canShowInstallHint() && isIosSafari());

    function updateOnlineState() {
      const nextOffline = !navigator.onLine;
      setOffline(nextOffline);
      if (!nextOffline) {
        setRecentlyRestored(true);
        void flushOfflineQueues();
        if (restoreTimerRef.current) window.clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = window.setTimeout(() => setRecentlyRestored(false), 4200);
      }
    }

    function onBeforeInstallPrompt(event: Event) {
      if (!canShowInstallHint()) return;
      event.preventDefault();
      setShowIosHint(false);
      setInstallEvent(event as BeforeInstallPromptEvent);
    }

    function onAppInstalled() {
      localStorage.setItem(INSTALL_ACCEPTED_KEY, '1');
      setInstallEvent(null);
      setShowIosHint(false);
    }

    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    void flushOfflineQueues();

    const canRegisterServiceWorker = process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator;
    if (canRegisterServiceWorker) {
      navigator.serviceWorker.register('/sw.js').then((registration) => {
        if (registration.waiting && navigator.serviceWorker.controller) {
          setUpdateWorker(registration.waiting);
        }
        registration.addEventListener('updatefound', () => {
          const nextWorker = registration.installing;
          if (!nextWorker) return;
          nextWorker.addEventListener('statechange', () => {
            if (nextWorker.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateWorker(nextWorker);
            }
          });
        });
      }).catch(() => undefined);

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshingRef.current) return;
        window.location.reload();
      });
    }

    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      if (restoreTimerRef.current) window.clearTimeout(restoreTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!nativeLikeSurface) return undefined;
    let lastTouchEnd = 0;
    const root = document.documentElement;
    const previousTouchAction = document.body.style.touchAction;

    root.classList.add('pwa-native');
    document.body.style.touchAction = 'manipulation';

    function preventMultiTouch(event: TouchEvent) {
      if (event.touches.length > 1) event.preventDefault();
    }

    function preventGesture(event: Event) {
      event.preventDefault();
    }

    function preventDoubleTapZoom(event: TouchEvent) {
      if (isControlTarget(event.target)) {
        lastTouchEnd = Date.now();
        return;
      }
      if (event.changedTouches.length !== 1) return;
      const now = Date.now();
      if (now - lastTouchEnd <= 320) event.preventDefault();
      lastTouchEnd = now;
    }

    function preventDoubleClickZoom(event: MouseEvent) {
      if (isControlTarget(event.target)) return;
      event.preventDefault();
    }

    document.addEventListener('touchmove', preventMultiTouch, { passive: false });
    document.addEventListener('touchend', preventDoubleTapZoom, { passive: false });
    document.addEventListener('dblclick', preventDoubleClickZoom, { passive: false });
    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });
    document.addEventListener('gestureend', preventGesture, { passive: false });

    return () => {
      root.classList.remove('pwa-native');
      document.body.style.touchAction = previousTouchAction;
      document.removeEventListener('touchmove', preventMultiTouch);
      document.removeEventListener('touchend', preventDoubleTapZoom);
      document.removeEventListener('dblclick', preventDoubleClickZoom);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      document.removeEventListener('gestureend', preventGesture);
    };
  }, [nativeLikeSurface, pathname]);

  async function installPwa() {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') {
      localStorage.setItem(INSTALL_ACCEPTED_KEY, '1');
    } else {
      localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    }
    setInstallEvent(null);
  }

  function dismissInstallPrompt() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    setInstallEvent(null);
    setShowIosHint(false);
  }

  function activateUpdate() {
    if (!updateWorker) return;
    refreshingRef.current = true;
    updateWorker.postMessage({ type: 'SKIP_WAITING' });
  }

  return (
    <>
      <OfflineBanner offline={offline} recentlyRestored={recentlyRestored} nativeLikeSurface={nativeLikeSurface} />
      {showInstallPrompt ? (
        <InstallPwaPrompt
          androidInstallReady={Boolean(installEvent)}
          iosHint={showIosHint}
          onInstall={() => { void installPwa(); }}
          onDismiss={dismissInstallPrompt}
        />
      ) : null}
      {updateWorker ? <UpdateAvailableToast onRefresh={activateUpdate} /> : null}
      <PwaDebugPanel nativeLikeSurface={nativeLikeSurface} />
    </>
  );
}

function OfflineBanner({ offline, recentlyRestored, nativeLikeSurface }: { offline: boolean; recentlyRestored: boolean; nativeLikeSurface: boolean }) {
  if (!offline && !recentlyRestored) return null;
  return (
    <div
      className={cn(
        'fixed inset-x-3 z-[80] mx-auto flex min-h-11 max-w-md items-center justify-center gap-2 rounded-2xl border px-4 py-2.5 text-center text-sm font-medium shadow-xl backdrop-blur',
        nativeLikeSurface ? 'bottom-24' : 'bottom-4 md:bottom-6',
        offline
          ? 'border-amber-200 bg-amber-50/95 text-amber-900 shadow-amber-950/10'
          : 'border-emerald-200 bg-emerald-50/95 text-emerald-900 shadow-emerald-950/10'
      )}
      role="status"
      aria-live="polite"
    >
      {offline ? <WifiOff size={17} className="shrink-0" /> : <Wifi size={17} className="shrink-0" />}
      <span>{offline ? '当前网络不可用，你仍可以查看已缓存的页面。' : '网络已恢复，正在同步数据'}</span>
    </div>
  );
}

function InstallPwaPrompt({ androidInstallReady, iosHint, onInstall, onDismiss }: { androidInstallReady: boolean; iosHint: boolean; onInstall: () => void; onDismiss: () => void }) {
  return (
    <div className="fixed inset-x-3 bottom-20 z-[70] mx-auto max-w-md rounded-2xl border border-slate-200 bg-white/95 p-4 text-slate-900 shadow-2xl shadow-slate-950/15 backdrop-blur lg:bottom-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white">
            {iosHint ? <Share size={18} /> : <Download size={18} />}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">添加到桌面</div>
            <div className="mt-1 text-xs leading-5 text-slate-600">
              {iosHint ? '点击分享按钮 → 添加到主屏幕' : '把书库星舰添加到桌面，获得更接近 App 的阅读体验。'}
            </div>
          </div>
        </div>
        <button type="button" onClick={onDismiss} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100" aria-label="关闭安装提示">
          <X size={17} />
        </button>
      </div>
      {androidInstallReady ? (
        <button type="button" onClick={onInstall} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition active:scale-[0.99] hover:bg-slate-800">
          <Download size={17} />
          添加到桌面
        </button>
      ) : null}
    </div>
  );
}

function UpdateAvailableToast({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="fixed inset-x-3 top-4 z-[90] mx-auto max-w-md rounded-2xl border border-blue-200 bg-blue-50/95 p-4 text-blue-950 shadow-2xl shadow-blue-950/10 backdrop-blur" role="status" aria-live="polite">
      <div className="text-sm font-semibold">发现新版本</div>
      <p className="mt-1 text-xs leading-5 text-blue-900">书库星舰已更新，刷新后即可使用新版阅读器</p>
      <button type="button" onClick={onRefresh} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white transition active:scale-[0.99] hover:bg-blue-700">
        <RefreshCw size={17} />
        立即刷新
      </button>
    </div>
  );
}

function shouldEnablePwaDebug() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('debug') ?? params.get('pwaDebug');
  if (requested === '1' || requested === 'true') {
    localStorage.setItem(PWA_DEBUG_ENABLED_KEY, '1');
    return true;
  }
  if (requested === '0' || requested === 'false') {
    localStorage.removeItem(PWA_DEBUG_ENABLED_KEY);
    return false;
  }
  return localStorage.getItem(PWA_DEBUG_ENABLED_KEY) === '1';
}

function stringifyDebugValue(value: unknown) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'undefined') return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getStandaloneLabel() {
  if (typeof window === 'undefined') return 'unknown';
  if (isStandaloneDisplay()) return 'standalone';
  if (window.matchMedia('(display-mode: browser)').matches) return 'browser';
  return 'unknown';
}

function PwaDebugPanel({ nativeLikeSurface }: { nativeLikeSurface: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [copied, setCopied] = useState(false);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const nextIdRef = useRef(1);

  function appendLog(level: DebugLevel, source: string, parts: unknown[]) {
    const entry: DebugLog = {
      id: nextIdRef.current,
      level,
      source,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      message: parts.map(stringifyDebugValue).join(' ')
    };
    nextIdRef.current += 1;
    setLogs((current) => [...current.slice(-119), entry]);
  }

  useEffect(() => {
    setEnabled(shouldEnablePwaDebug());
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error'];
    const originals = new Map<ConsoleMethod, typeof console.log>();
    methods.forEach((method) => {
      const original = console[method];
      originals.set(method, original);
      console[method] = (...args: unknown[]) => {
        original.apply(console, args);
        appendLog(method, 'console', args);
      };
    });

    function recordOnlineState() {
      appendLog(navigator.onLine ? 'info' : 'warn', 'network', [navigator.onLine ? 'online' : 'offline']);
    }

    function recordVisibility() {
      appendLog('info', 'page', [`visibility=${document.visibilityState}`]);
    }

    function recordError(event: ErrorEvent) {
      appendLog('error', 'window', [event.message, event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '']);
    }

    function recordUnhandledRejection(event: PromiseRejectionEvent) {
      appendLog('error', 'promise', [event.reason]);
    }

    function recordServiceWorkerMessage(event: MessageEvent) {
      if (event.data?.type !== 'PWA_DEBUG_LOG') return;
      const payload = event.data.payload as { level?: DebugLevel; source?: string; message?: string; details?: unknown };
      appendLog(payload.level ?? 'info', payload.source ?? 'service-worker', [payload.message, payload.details].filter(Boolean));
    }

    function recordControllerChange() {
      appendLog('info', 'service-worker', ['controllerchange']);
    }

    appendLog('info', 'pwa', [
      `mode=${getStandaloneLabel()}`,
      `online=${navigator.onLine}`,
      `secure=${window.isSecureContext}`,
      `sw=${'serviceWorker' in navigator ? 'supported' : 'unsupported'}`
    ]);

    navigator.serviceWorker?.getRegistration().then((registration) => {
      appendLog('info', 'service-worker', [
        registration
          ? `scope=${registration.scope} active=${registration.active?.state ?? 'none'} waiting=${registration.waiting?.state ?? 'none'}`
          : 'not registered'
      ]);
    }).catch((error) => appendLog('warn', 'service-worker', ['registration lookup failed', error]));

    window.addEventListener('online', recordOnlineState);
    window.addEventListener('offline', recordOnlineState);
    document.addEventListener('visibilitychange', recordVisibility);
    window.addEventListener('error', recordError);
    window.addEventListener('unhandledrejection', recordUnhandledRejection);
    navigator.serviceWorker?.addEventListener('message', recordServiceWorkerMessage);
    navigator.serviceWorker?.addEventListener('controllerchange', recordControllerChange);

    return () => {
      methods.forEach((method) => {
        const original = originals.get(method);
        if (original) console[method] = original;
      });
      window.removeEventListener('online', recordOnlineState);
      window.removeEventListener('offline', recordOnlineState);
      document.removeEventListener('visibilitychange', recordVisibility);
      window.removeEventListener('error', recordError);
      window.removeEventListener('unhandledrejection', recordUnhandledRejection);
      navigator.serviceWorker?.removeEventListener('message', recordServiceWorkerMessage);
      navigator.serviceWorker?.removeEventListener('controllerchange', recordControllerChange);
    };
  }, [enabled]);

  function disableDebug() {
    localStorage.removeItem(PWA_DEBUG_ENABLED_KEY);
    setEnabled(false);
  }

  async function copyLogs() {
    const text = logs.map((log) => `[${log.time}] ${log.source}/${log.level}: ${log.message}`).join('\n');
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  if (!enabled) return null;

  return (
    <div className={cn('fixed inset-x-2 z-[120] mx-auto max-w-xl text-slate-50', nativeLikeSurface ? 'bottom-24' : 'bottom-3')}>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="ml-auto flex min-h-11 items-center gap-2 rounded-full border border-slate-700 bg-slate-950/95 px-4 text-xs font-medium shadow-2xl shadow-slate-950/25 backdrop-blur"
          aria-label="打开 PWA 调试面板"
        >
          <Bug size={16} />
          PWA Debug
        </button>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/95 shadow-2xl shadow-slate-950/30 backdrop-blur">
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-800 px-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Bug size={15} />
              PWA Debug
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => { void copyLogs(); }} className="flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-800" aria-label="复制日志">
                <Clipboard size={15} />
              </button>
              <button type="button" onClick={() => setLogs([])} className="flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-800" aria-label="清空日志">
                <Trash2 size={15} />
              </button>
              <button type="button" onClick={() => setCollapsed(true)} className="flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-800" aria-label="收起调试面板">
                <X size={15} />
              </button>
            </div>
          </div>
          {copied ? <div className="border-b border-emerald-900/60 bg-emerald-950 px-3 py-2 text-xs text-emerald-100">日志已复制</div> : null}
          <div className="max-h-72 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5" data-pwa-scroll="true">
            {logs.length ? logs.map((log) => (
              <div key={log.id} className={cn('break-words border-b border-slate-900 py-1 last:border-0', log.level === 'error' ? 'text-rose-200' : log.level === 'warn' ? 'text-amber-200' : 'text-slate-200')}>
                <span className="text-slate-500">{log.time}</span>
                <span className="ml-2 text-slate-400">{log.source}/{log.level}</span>
                <span className="ml-2">{log.message}</span>
              </div>
            )) : <div className="py-5 text-center text-slate-500">暂无日志</div>}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-3 py-2 text-[11px] text-slate-400">
            <span>URL 加 ?debug=0 可关闭持久开关</span>
            <button type="button" onClick={disableDebug} className="rounded-full px-3 py-1.5 text-slate-300 transition hover:bg-slate-800">关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}

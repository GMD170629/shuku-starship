'use client';

import { Download, RefreshCw, Share, Wifi, WifiOff, X } from 'lucide-react';
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

import './globals.css';
import type { Metadata, Viewport } from 'next';
import { AppShell } from '../components/layout/app-shell';

export const metadata: Metadata = {
  title: '书库星舰',
  description: '自托管 NAS 读物管理与移动阅读系统',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: '书库星舰'
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
      { url: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' }
    ],
    apple: [{ url: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' }]
  }
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F7F9' },
    { media: '(prefers-color-scheme: dark)', color: '#F6F7F9' }
  ],
  colorScheme: 'light dark'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

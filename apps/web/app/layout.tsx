import './globals.css';
import type { Metadata, Viewport } from 'next';
import { AppShell } from '../components/layout/app-shell';
import { FeedbackProvider } from '../components/ui/feedback';

export const metadata: Metadata = {
  title: '书库星舰',
  description: '自托管 NAS 读物管理与移动阅读系统',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: '书库星舰'
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ],
    apple: [
      { url: '/apple-touch-icon-120x120.png', sizes: '120x120', type: 'image/png' },
      { url: '/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { url: '/apple-touch-icon-167x167.png', sizes: '167x167', type: 'image/png' },
      { url: '/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
    ],
    other: [
      { rel: 'apple-touch-icon-precomposed', url: '/apple-touch-icon-precomposed.png', sizes: '180x180', type: 'image/png' }
    ]
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F7F9' },
    { media: '(prefers-color-scheme: dark)', color: '#F6F7F9' }
  ],
  colorScheme: 'light dark'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
      </head>
      <body>
        <FeedbackProvider>
          <AppShell>{children}</AppShell>
        </FeedbackProvider>
      </body>
    </html>
  );
}

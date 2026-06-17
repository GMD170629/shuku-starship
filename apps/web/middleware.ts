import { NextResponse, type NextRequest } from 'next/server';

const publicPaths = ['/login', '/mobile', '/offline', '/api/auth/login', '/api/health'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    publicPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
  }

  const isApi = pathname.startsWith('/api/');
  const hasSession = Boolean(request.cookies.get('shuku_session')?.value);
  if (!hasSession) {
    if (isApi) {
      return NextResponse.json({ ok: false, error: { message: '未登录' } }, { status: 401 });
    }
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!.*\\.).*)']
};

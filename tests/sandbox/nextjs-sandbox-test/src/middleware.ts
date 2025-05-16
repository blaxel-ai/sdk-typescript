import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Paths that don't require authentication
const publicPaths = ['/login', '/api/auth/login'];

export function middleware(request: NextRequest) {
  const userEmail = request.cookies.get('user_email')?.value;
  const isLoggedIn = !!userEmail;
  const { pathname } = request.nextUrl;

  // Allow access to public paths even if not logged in
  if (publicPaths.includes(pathname) || pathname.startsWith('/_next') || pathname.includes('/favicon.ico')) {
    return NextResponse.next();
  }

  // Check if the path is an API route and not the auth route
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) {
    if (!isLoggedIn) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Redirect to login page if not logged in
  if (!isLoggedIn) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip all static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
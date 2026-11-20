import { NextRequest, NextResponse } from 'next/server'

/**
 * Optional HTTP Basic Auth protection.
 *
 * Set SIFTLY_USERNAME and SIFTLY_PASSWORD in your .env to enable.
 * Leave both unset (the default) for unrestricted local access.
 *
 * The bookmarklet endpoint is excluded so cross-origin imports from x.com
 * continue to work regardless of auth configuration.
 */
/** tex: constant-time string compare (no early exit on the first differing character) */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

export function middleware(request: NextRequest): NextResponse {
  const username = process.env.SIFTLY_USERNAME?.trim()
  const password = process.env.SIFTLY_PASSWORD?.trim()

  const path = request.nextUrl.pathname

  // tex: the bookmarklet endpoint is unauthenticated by design — disabled unless opted in.
  if (path === '/api/import/bookmarklet' && process.env.SIFTLY_ENABLE_BOOKMARKLET !== '1') {
    return new NextResponse('Bookmarklet import is disabled (SIFTLY_ENABLE_BOOKMARKLET=1 to enable)', { status: 404 })
  }
  // tex: cookie-based X sync (auth_token/ct0, internal GraphQL) stays off unless opted in.
  if ((path === '/api/import/twitter' || path.startsWith('/api/import/live')) && process.env.SIFTLY_ENABLE_COOKIE_SYNC !== '1') {
    return new NextResponse('Cookie-based X sync is disabled (SIFTLY_ENABLE_COOKIE_SYNC=1 to enable)', { status: 404 })
  }

  // No credentials configured → pass through (default local behaviour)
  if (!username || !password) return NextResponse.next()

  // Let the bookmarklet endpoint through — it's called cross-origin from x.com
  // and can't include Basic Auth credentials.
  if (path === '/api/import/bookmarklet') {
    return NextResponse.next()
  }

  const authHeader = request.headers.get('Authorization')

  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = atob(authHeader.slice(6))
      const colonIdx = decoded.indexOf(':')
      if (colonIdx !== -1) {
        const user = decoded.slice(0, colonIdx)
        const pass = decoded.slice(colonIdx + 1)
        if (safeEqual(user, username) && safeEqual(pass, password)) {
          return NextResponse.next()
        }
      }
    } catch {
      // malformed base64 → fall through to 401
    }
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Siftly"' },
  })
}

export const config = {
  matcher: [
    // Match everything except Next.js internals (_next/static, _next/image,
    // _next/webpack-hmr dev HMR websocket, etc.) and static root files.
    '/((?!_next/|favicon.ico|icon.svg).*)',
  ],
}

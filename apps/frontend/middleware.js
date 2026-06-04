export function middleware(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      url.pathname = '/zh';
      return Response.redirect(url);
    }
  }
  export const config = { matcher: '/' };
  
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next 16 renamed middleware to proxy. Sends bare paths to the Chinese locale,
// which is the primary audience.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/zh") || pathname.startsWith("/en")) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL("/zh", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.).*)"],
};

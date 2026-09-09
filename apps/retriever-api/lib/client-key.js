// Deriving the rate-limit bucket for a request.
import { ipKeyGenerator } from 'express-rate-limit';

// Rate limiting must key on the real visitor, not a proxy hop. Render fronts the
// service with Cloudflare, and with that chain Express's req.ip resolves to a
// rotating edge address: every request then gets its own bucket and the limits
// silently never apply. Cloudflare sets CF-Connecting-IP at the edge and strips
// any client-supplied copy, so prefer it, then the left-most X-Forwarded-For
// entry, and fall back to req.ip when running without a proxy.
export function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = (typeof cf === 'string' && cf.trim()) || xff || req.ip || 'unknown';
  // Groups IPv6 addresses into /64 subnets; a single host owns many addresses.
  return ipKeyGenerator(ip);
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Adjust this to  repo root (two levels up from apps/frontend)
const monorepoRoot = path.resolve(__dirname, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  // Important in monorepos:
  outputFileTracingRoot: monorepoRoot,
  // (optional but helpful)
  experimental: {
    // leave other experiments if you actually use them, but NOT typedRoutes here
  },
};

export default nextConfig;

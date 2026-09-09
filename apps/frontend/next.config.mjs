import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the Docker image. Vercel builds its own
  // serverless output and does not want this, so it is scoped to non-Vercel builds.
  output: process.env.VERCEL ? undefined : "standalone",
  // The workspace root, so tracing picks up hoisted dependencies.
  outputFileTracingRoot: monorepoRoot,
  // No next/image usage; skips pulling sharp into the runtime.
  images: { unoptimized: true },
};

export default nextConfig;

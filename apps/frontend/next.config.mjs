import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Adjust this to  repo root (two levels up from apps/frontend)
const monorepoRoot = path.resolve(__dirname, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  // Self-contained server bundle for the Docker image. Without this the runtime
  // stage would need the full node_modules tree.
  output: "standalone",
  // The workspace root, so tracing picks up hoisted dependencies.
  outputFileTracingRoot: monorepoRoot,
};

export default nextConfig;

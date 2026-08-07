import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@tuezday/contracts", "@tuezday/brain"],
  // Standalone output so the web container only ships a pruned server bundle,
  // not the whole workspace node_modules.
  output: "standalone",
  // Without this, Next traces file dependencies from apps/web and can miss
  // the workspace packages @tuezday/contracts and @tuezday/brain — the build
  // succeeds but the standalone server then fails at runtime with
  // module-not-found. Point it at the monorepo root so tracing covers the
  // whole workspace. Do not remove.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
};

export default nextConfig;

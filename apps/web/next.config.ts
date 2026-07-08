import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const rootEnvFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
if (fs.existsSync(rootEnvFile)) {
  for (const line of fs.readFileSync(rootEnvFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*(NEXT_PUBLIC_[A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/^["']|["']$/g, "").trim();
    if (value && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = value;
    }
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ["@tuezday/contracts", "@tuezday/brain"],
};

export default nextConfig;

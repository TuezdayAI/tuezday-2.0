import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@tuezday/contracts", "@tuezday/brain"],
};

export default nextConfig;

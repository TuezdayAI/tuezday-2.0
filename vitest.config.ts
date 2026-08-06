import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/api",
      "apps/web",
      "apps/worker",
      "apps/renderer",
      "packages/contracts",
      "packages/brain",
    ],
  },
});

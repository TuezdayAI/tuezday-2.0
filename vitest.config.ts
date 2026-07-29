import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/api",
      "apps/web",
      "apps/worker",
      "packages/contracts",
      "packages/brain",
    ],
  },
});

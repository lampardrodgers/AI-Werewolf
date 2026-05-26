import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node"
  },
  resolve: {
    alias: {
      "@langrensha/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@langrensha/engine": path.resolve(__dirname, "packages/engine/src/index.ts"),
      "@langrensha/prompts": path.resolve(__dirname, "packages/prompts/src/index.ts"),
      "@langrensha/llm-gateway": path.resolve(__dirname, "packages/llm-gateway/src/index.ts")
    }
  }
});

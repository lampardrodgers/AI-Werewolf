import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@langrensha/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@langrensha/engine": path.resolve(__dirname, "../../packages/engine/src/index.ts"),
      "@langrensha/prompts": path.resolve(__dirname, "../../packages/prompts/src/index.ts"),
      "@langrensha/llm-gateway": path.resolve(__dirname, "../../packages/llm-gateway/src/index.ts")
    }
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  }
});

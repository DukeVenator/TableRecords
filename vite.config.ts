import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./src/web", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/web", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    host: "127.0.0.1",
    port: 17301,
    proxy: {
      "/api": "http://127.0.0.1:17300"
    }
  }
});

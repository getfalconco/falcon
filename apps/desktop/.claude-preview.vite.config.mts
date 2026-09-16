import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer"),
      "@fontsource": resolve(__dirname, "node_modules/@fontsource"),
    },
  },
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});

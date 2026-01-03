import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env": JSON.stringify({ NODE_ENV: "production" }),
  },
  build: {
    outDir: resolve(__dirname, "public", "widget"),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, "src", "widget", "main.tsx"),
      formats: ["es"],
      fileName: () => "widget.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        banner:
          "(function(){var p=globalThis.process;if(!p){globalThis.process={env:{NODE_ENV:\"production\"}};}else if(!p.env){p.env={NODE_ENV:\"production\"};}else if(!(\"NODE_ENV\" in p.env)){p.env.NODE_ENV=\"production\";}})();",
        assetFileNames: assetInfo =>
          assetInfo.name && assetInfo.name.endsWith(".css")
            ? "widget.css"
            : "[name][extname]",
      },
    },
  },
});

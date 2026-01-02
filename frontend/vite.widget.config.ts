import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
        assetFileNames: assetInfo =>
          assetInfo.name && assetInfo.name.endsWith(".css")
            ? "widget.css"
            : "[name][extname]",
      },
    },
  },
});

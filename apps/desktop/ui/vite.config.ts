import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** pdf.js data files (CMaps for Korean text, standard fonts, JS image decoder fallbacks) served from dist/pdfjs/ under the CSP's 'self'. */
function pdfjsData(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  return {
    name: "pdfjs-data",
    apply: "build",
    generateBundle() {
      for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
        // useWasm is off (pdf-browser.ts), so only the JS fallbacks are shipped from wasm/.
        for (const name of readdirSync(join(root, dir)).filter((n) => dir !== "wasm" || n.endsWith("_fallback.js"))) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
        }
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), pdfjsData()],
  build: { outDir: "dist", emptyOutDir: true },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { excalidrawZoom } from "./excalidrawZoom";
import { excalidrawTypography } from "./excalidrawTypography";

const require = createRequire(import.meta.url);
const editorBundle = require
  .resolve("@excalidraw/excalidraw")
  .replace(/prod[/\\]index\.js$/, "dev/index.js");
const fontCatalog = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../backend/assets/board-fonts/catalog.json"),
    "utf8",
  ),
);
// The optimizer otherwise reuses its cached bundles after a patch-only edit.
const runsModule = path.resolve(__dirname, "src/utils/boardTextRuns.ts");
const typographyRevision = createHash("sha256")
  .update(fs.readFileSync(path.resolve(__dirname, "excalidrawTypography.ts")))
  .update(fs.readFileSync(path.resolve(__dirname, "excalidrawZoom.ts")))
  .update(fs.readFileSync(runsModule))
  .update(JSON.stringify(fontCatalog))
  .digest("hex")
  .slice(0, 12);
const typography = excalidrawTypography(
  fontCatalog,
  typographyRevision,
  runsModule,
);

const versionFilePath = path.resolve(__dirname, "../VERSION");
const appVersion = fs.readFileSync(versionFilePath, "utf8").trim();
if (
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(appVersion)
) {
  throw new Error(`Invalid VERSION: ${JSON.stringify(appVersion)}`);
}
const buildLabel =
  process.env.VITE_APP_BUILD_LABEL?.trim() || "local development build";

export default defineConfig(({ command }) => {
  const nodeEnv =
    process.env.NODE_ENV ||
    (command === "build" ? "production" : "development");
  const devBackendTarget =
    process.env.VITE_DEV_BACKEND_URL?.trim() || "http://localhost:8000";
  const processEnvDefines = {
    "process.env.IS_PREACT": JSON.stringify("false"),
    "process.env.NODE_ENV": JSON.stringify(nodeEnv),
  };

  return {
    plugins: [react(), excalidrawZoom, typography.vite],
    resolve: {
      alias: [{ find: /^@excalidraw\/excalidraw$/, replacement: editorBundle }],
    },
    define: {
      ...processEnvDefines,
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      "import.meta.env.VITE_APP_BUILD_LABEL": JSON.stringify(buildLabel),
    },
    optimizeDeps: {
      esbuildOptions: {
        define: processEnvDefines,
        target: "es2022",
        plugins: [typography.optimizer],
      },
    },
    build: {
      chunkSizeWarningLimit: 2000,
    },
    server: {
      proxy: {
        "/api": {
          target: devBackendTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/socket.io": {
          target: devBackendTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Same resolver as the pipeline CLI: .env, .env.local, DOTENV, shell env.
import { resolveAppConfig, siteBuildStampPath } from "../pipeline/src/config.ts";

/** Full-reload the page whenever `bun run dev` finishes rebuilding site data. */
function reloadOnSiteRebuild(stampFile: string): Plugin {
  return {
    name: "riscv-cn-reload-on-site-rebuild",
    configureServer(server) {
      server.watcher.add(stampFile);
      const onChange = (file: string) => {
        if (file === stampFile) server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("change", onChange);
      server.watcher.on("add", onChange);
    },
  };
}

export default defineConfig(() => {
  const cfg = resolveAppConfig({}, { applyToProcessEnv: false });

  return {
    base: cfg.viewerBasePath,
    // Config comes from the resolver above and is injected explicitly. (Vite's own
    // envDir stays at packages/viewer, which holds no .env files.)
    define: {
      "import.meta.env.VITE_DATA_URL": JSON.stringify(cfg.viteDataUrl),
    },
    server: {
      port: cfg.viewerPort,
    },
    preview: {
      port: cfg.viewerPort,
    },
    plugins: [react(), tailwindcss(), reloadOnSiteRebuild(siteBuildStampPath(cfg))],
  };
});

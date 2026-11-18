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

/**
 * Ensures every `<script>` tag in the built HTML carries `data-cfasync="false"`
 * as its first attribute (strictly before `src` and `type`), so Cloudflare Rocket
 * Loader leaves both the synchronous theme bootstrap and Vite ES module bundles
 * untouched without requiring Rocket Loader to be disabled at the zone level.
 */
export function withCloudflareRocketLoaderCompat(html: string): string {
  return html.replace(/<script\b([^>]*)>/gi, (_full, attrs: string) => {
    const cleaned = attrs.replace(/\s*\bdata-cfasync=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<script data-cfasync="false"${cleaned}>`;
  });
}

function cloudflareRocketLoaderCompat(): Plugin {
  return {
    name: "riscv-cn-cf-rocket-loader-compat",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return withCloudflareRocketLoaderCompat(html);
      },
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
    plugins: [
      react(),
      tailwindcss(),
      reloadOnSiteRebuild(siteBuildStampPath(cfg)),
      cloudflareRocketLoaderCompat(),
    ],
  };
});

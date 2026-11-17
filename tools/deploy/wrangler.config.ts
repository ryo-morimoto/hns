import { defineWranglerConfig, type WranglerConfig } from "wrangler/experimental-config";

/**
 * The Wrangler build settings for the deploy project.
 *
 * @remarks
 * The runtime asset fields live in `cloudflare.config.ts`; only the asset directory is a
 * build setting. `npm run build -w @hns/web` writes there, and the Worker serves it through
 * the `ASSETS` binding. Source maps are not uploaded: production serves the generated JS only.
 */
export const buildSettings = {
  assetsDirectory: "../../deploy/assets",
  uploadSourceMaps: false,
  types: { generate: false },
} satisfies WranglerConfig;

export default defineWranglerConfig(buildSettings);

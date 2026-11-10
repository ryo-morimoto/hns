import { bindings, defineConfig, exports } from "cf/config";

// HNS_AGENT_URL lets `cf deploy` point the Worker at a tunnel host without editing this file.
export default defineConfig({
	worker: {
		name: "hns-cf-poc",
		compatibilityDate: "2026-10-30",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "src/worker.js",
		exports: {
			Session: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			AGENT_URL: bindings.text(process.env.HNS_AGENT_URL ?? "http://127.0.0.1:8788"),
			HNS_MODEL: bindings.text("faux/echo"),
			SESSION: bindings.durableObject({
				worker: "hns-cf-poc",
				exportName: "Session",
			}),
		},
	},
});

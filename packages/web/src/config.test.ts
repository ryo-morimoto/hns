// @vitest-environment node
import { expect, test } from "vitest";
import config from "../vite.config.ts";
import { DEFAULT_API_ORIGIN, proxyFor } from "../vite.proxy.ts";

// Catches: a dev server that needs CORS for GraphQL or cannot upgrade the WebSocket.
test("development proxies GraphQL, the API, and the socket to the local Worker", () => {
  const proxy = proxyFor();
  expect(proxy["/graphql"]).toStrictEqual({ target: DEFAULT_API_ORIGIN, changeOrigin: false });
  expect(proxy["/api"]).toStrictEqual({ target: DEFAULT_API_ORIGIN, changeOrigin: false });
  expect(proxy["/ws"]).toStrictEqual({
    target: DEFAULT_API_ORIGIN,
    changeOrigin: false,
    ws: true,
  });
  expect(proxyFor("http://127.0.0.1:9999/")["/ws"]?.target).toBe("http://127.0.0.1:9999");
  const configured = config.server?.proxy;
  expect(configured).toHaveProperty("/graphql");
  expect(configured).toHaveProperty("/api");
  expect(configured).toHaveProperty("/ws");
});

// Catches: a build that ships to the wrong directory or leaks source maps.
test("the build writes deploy/assets without source maps", () => {
  expect(config.build?.outDir).toBe("../../deploy/assets");
  expect(config.build?.emptyOutDir).toBe(true);
  expect(config.build?.assetsDir).toBe("assets");
  expect(config.build?.sourcemap).toBe(false);
});

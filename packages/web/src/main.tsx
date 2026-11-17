import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RelayEnvironmentProvider } from "react-relay";
import { Shell } from "./app/Shell.tsx";
import { fixtureSummarySource } from "./app/fixtureSummaries.ts";
import { applyTheme, readTheme } from "./app/theme.ts";
import { redirectToLogin } from "./auth/login.ts";
import { Gallery } from "./design/Gallery.tsx";
import { browserLiveSocket } from "./live/client.ts";
import { createEnvironment } from "./relay/environment.ts";
import "./design/system.css";

// Apply the stored theme before the first paint so the shell does not flash the OS default.
applyTheme(readTheme(window.localStorage));

const environment = createEnvironment({
  // The login screen (0108) returns to the URL this keeps; the redirect stops at /login.
  onUnauthorized: () => {
    redirectToLogin(window.location, (href) => window.location.assign(href));
  },
});
const gallery = import.meta.env.DEV && window.location.hash === "#/design";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing #root");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false } },
});

createRoot(container).render(
  <StrictMode>
    {gallery ? (
      <Gallery />
    ) : (
      <RelayEnvironmentProvider environment={environment}>
        <QueryClientProvider client={queryClient}>
          <Shell summarySource={fixtureSummarySource} liveSocket={browserLiveSocket} />
        </QueryClientProvider>
      </RelayEnvironmentProvider>
    )}
  </StrictMode>,
);

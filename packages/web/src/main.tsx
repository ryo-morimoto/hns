import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./app/Shell.tsx";
import { createFixtureSource } from "./app/fixtureSource.ts";
import { fixtureSummarySource } from "./app/fixtureSummaries.ts";
import { applyTheme, readTheme } from "./app/theme.ts";
import { Gallery } from "./design/Gallery.tsx";
import "./design/system.css";

// Apply the stored theme before the first paint so the shell does not flash the OS default.
applyTheme(readTheme(window.localStorage));

// There is no server yet; Relay replaces the fixture reads once it lands.
const source = createFixtureSource();
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
      <QueryClientProvider client={queryClient}>
        <Shell source={source} summarySource={fixtureSummarySource} />
      </QueryClientProvider>
    )}
  </StrictMode>,
);

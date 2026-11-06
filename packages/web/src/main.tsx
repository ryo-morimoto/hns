import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createWebClient } from "./api/client.ts";
import { createFixtureFetch } from "./api/fixtures.ts";
import "./design/system.css";

const fixtures = import.meta.env.VITE_HNS_FIXTURES === "1";
const client = createWebClient({ baseUrl: "", fetch: fixtures ? createFixtureFetch() : fetch });

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing #root");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false } },
});

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App client={client} />
    </QueryClientProvider>
  </StrictMode>,
);

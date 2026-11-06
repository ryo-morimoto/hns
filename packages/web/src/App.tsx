import { useQuery } from "@tanstack/react-query";
import type { WebClient } from "./api/client.ts";

export interface AppProps {
  readonly client: WebClient;
}

/**
 * The 0100 harness: enough of the Workspace to prove the typed client, fixtures, and jsdom
 * harness work. The real shell and screens are 0102 and 0104.
 */
export function App({ client }: AppProps) {
  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => client.request("GET /api/state"),
  });

  return (
    <main>
      <h1>Workspace</h1>
      {state.isPending ? <p>Loading…</p> : null}
      {state.isError ? <p role="alert">{state.error.message}</p> : null}
      {state.isSuccess ? (
        <>
          <p>
            {state.data.provider} / {state.data.model}
          </p>
          <p>
            {state.data.counts.projects} projects · {state.data.counts.conversations} conversations
          </p>
          <ul>
            {state.data.tasks.map((task) => (
              <li key={task.id}>
                {task.kind} ({task.state})
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void state.refetch()}>
            Refresh
          </button>
        </>
      ) : null}
    </main>
  );
}

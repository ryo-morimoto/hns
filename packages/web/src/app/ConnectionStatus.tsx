import type { ReactElement } from "react";

export type Connection = "connecting" | "online" | "offline";

const LABELS: Record<Connection, string> = {
  connecting: "接続中",
  online: "接続済み",
  offline: "未接続",
};

export function ConnectionStatus({
  connection,
}: {
  readonly connection: Connection;
}): ReactElement {
  return (
    <span className="hns-connection" data-state={connection} role="status">
      <span className="hns-connection__dot" aria-hidden="true" />
      {LABELS[connection]}
    </span>
  );
}

import type { Project } from "@hns/core";
import type { ReactElement } from "react";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { Menu } from "../components/Menu.tsx";
import { THEMES, type Theme } from "./theme.ts";

type Connection = "connecting" | "online" | "offline";

const THEME_LABELS: Record<Theme, string> = {
  system: "システム",
  light: "ライト",
  dark: "ダーク",
};

const CONNECTION_LABELS: Record<Connection, string> = {
  connecting: "接続中",
  online: "接続済み",
  offline: "未接続",
};

export interface TopBarProps {
  readonly projectName: string;
  readonly projects: readonly Project[];
  readonly location: string;
  readonly connection: Connection;
  readonly theme: Theme;
  readonly mobile: boolean;
  readonly onSelectProject: (project: Project) => void;
  readonly onTheme: (theme: Theme) => void;
  readonly onOpenDrawer: () => void;
  readonly onOpenCommand: (() => void) | undefined;
}

export function TopBar({
  projectName,
  projects,
  location,
  connection,
  theme,
  mobile,
  onSelectProject,
  onTheme,
  onOpenDrawer,
  onOpenCommand,
}: TopBarProps): ReactElement {
  return (
    <header className="hns-topbar">
      {mobile ? (
        <Button variant="icon" aria-label="メニューを開く" onClick={onOpenDrawer}>
          <Icon name="menu" />
        </Button>
      ) : null}

      {projects.length === 0 ? (
        <Button variant="ghost" disabled>
          {projectName}
        </Button>
      ) : (
        <Menu
          label="プロジェクト"
          trigger={
            <Button variant="ghost">
              <span className="hns-topbar__project">{projectName}</span>
              <Icon name="chevron-down" size={12} />
            </Button>
          }
          items={projects.map((project) => ({
            label: project.name,
            onSelect: () => onSelectProject(project),
          }))}
        />
      )}

      <span className="hns-topbar__location">{location}</span>
      <span className="hns-topbar__spacer" />

      <span className="hns-connection" data-state={connection} role="status">
        <span className="hns-connection__dot" aria-hidden="true" />
        {CONNECTION_LABELS[connection]}
      </span>

      <Menu
        label="テーマ"
        trigger={<Button variant="ghost">テーマ</Button>}
        items={THEMES.map((choice) => ({
          label: THEME_LABELS[choice],
          selected: theme === choice,
          onSelect: () => onTheme(choice),
        }))}
      />

      {mobile ? null : (
        <Button
          variant="ghost"
          onClick={onOpenCommand}
          disabled={onOpenCommand === undefined}
          title={onOpenCommand === undefined ? "0103 で実装" : undefined}
        >
          コマンド
        </Button>
      )}
    </header>
  );
}

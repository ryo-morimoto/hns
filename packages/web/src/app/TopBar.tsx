import type { ReactElement } from "react";
import type { ProjectLink } from "./viewModel.ts";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { Menu } from "../components/Menu.tsx";
import { ConnectionStatus, type Connection } from "./ConnectionStatus.tsx";
import { THEME_LABELS, THEMES, type Theme } from "./theme.ts";

export interface TopBarProps {
  readonly projectName: string;
  readonly projects: readonly ProjectLink[];
  readonly location: string;
  readonly title: string;
  readonly connection: Connection;
  readonly theme: Theme;
  readonly mobile: boolean;
  readonly menuBadge: number;
  readonly onSelectProject: (project: ProjectLink) => void;
  readonly onTheme: (theme: Theme) => void;
  readonly onOpenDrawer: () => void;
  readonly onBack: (() => void) | undefined;
  readonly onOpenCommand: (() => void) | undefined;
}

export function TopBar({
  projectName,
  projects,
  location,
  title,
  connection,
  theme,
  mobile,
  menuBadge,
  onSelectProject,
  onTheme,
  onOpenDrawer,
  onBack,
  onOpenCommand,
}: TopBarProps): ReactElement {
  if (mobile) {
    // Low chrome: menu, the page title, one action. Project, theme, and connection live in
    // the drawer so the content keeps the width (interface.md 14).
    return (
      <header className="hns-topbar hns-topbar--mobile">
        {onBack === undefined ? (
          <Button
            variant="icon"
            aria-label={
              menuBadge > 0 ? "メニュー（Needs you " + String(menuBadge) + "）" : "メニューを開く"
            }
            onClick={onOpenDrawer}
          >
            <span className="hns-menu-badge-wrap">
              <Icon name="menu" />
              {menuBadge > 0 ? (
                <span className="hns-menu-badge" aria-hidden="true">
                  {menuBadge > 99 ? "99+" : String(menuBadge)}
                </span>
              ) : null}
            </span>
          </Button>
        ) : (
          <Button variant="icon" aria-label="ワークスペースへ戻る" onClick={onBack}>
            <Icon name="back" />
          </Button>
        )}
        <span className="hns-topbar__title">{title}</span>
        {onOpenCommand === undefined ? null : (
          <Button variant="icon" aria-label="コマンド" onClick={onOpenCommand}>
            <Icon name="search" />
          </Button>
        )}
      </header>
    );
  }

  return (
    <header className="hns-topbar">
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

      <ConnectionStatus connection={connection} />

      <Menu
        label="テーマ"
        trigger={<Button variant="ghost">テーマ</Button>}
        items={THEMES.map((choice) => ({
          label: THEME_LABELS[choice],
          selected: theme === choice,
          onSelect: () => onTheme(choice),
        }))}
      />

      <Button
        variant="ghost"
        onClick={onOpenCommand}
        disabled={onOpenCommand === undefined}
        title={onOpenCommand === undefined ? "未実装" : undefined}
      >
        コマンド
      </Button>
    </header>
  );
}

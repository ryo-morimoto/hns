import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { Menu } from "../components/Menu.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Toast } from "../components/Toast.tsx";

type ThemeChoice = "system" | "light" | "dark";

const TOKENS = [
  "--bg",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--border",
  "--border-strong",
  "--text",
  "--text-2",
  "--text-3",
  "--accent",
  "--danger",
  "--warn",
  "--ok",
  "--focus",
] as const;

/**
 * A dev-only page for reviewing the design system by hand (0101). It is not part of the
 * product: open /#/design while the dev server runs and use light/dark plus the keyboard.
 */
export function Gallery() {
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  return (
    <main style={{ padding: 24, display: "grid", gap: 28, maxWidth: 960, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>hns design system</h1>
        <span style={{ flex: 1 }} />
        {(["system", "light", "dark"] as const).map((choice) => (
          <Button
            key={choice}
            variant={theme === choice ? "primary" : "ghost"}
            aria-pressed={theme === choice}
            onClick={() => setTheme(choice)}
          >
            {choice}
          </Button>
        ))}
      </header>

      <Section title="Tokens">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 8,
          }}
        >
          {TOKENS.map((token) => (
            <div key={token} style={{ display: "grid", gap: 4 }}>
              <span
                style={{
                  height: 34,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: `var(${token})`,
                }}
              />
              <code style={{ fontSize: 11, color: "var(--text-2)" }}>{token}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Button">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button>保存</Button>
          <Button variant="ghost">キャンセル</Button>
          <Button variant="danger">削除</Button>
          <Button variant="icon" aria-label="閉じる">
            <Icon name="close" />
          </Button>
          <Button disabled>disabled</Button>
          <Button loading>loading</Button>
          <Button variant="ghost" loading>
            読み込み中
          </Button>
        </div>
      </Section>

      <Section title="Badge / Icon / Skeleton">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Badge>todo</Badge>
          <Badge tone="accent">doing</Badge>
          <Badge tone="ok">done</Badge>
          <Badge tone="warn">waiting</Badge>
          <Badge tone="danger">blocked</Badge>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--text-2)" }}>
          {(["close", "chevron-down", "check", "alert"] as const).map((name) => (
            <span key={name} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <Icon name={name} size={12} />
              <Icon name={name} size={14} />
              <Icon name={name} size={16} />
            </span>
          ))}
        </div>
        <div style={{ display: "grid", gap: 6, maxWidth: 420 }}>
          <Skeleton width="60%" height={10} />
          <Skeleton width="90%" height={10} />
          <Skeleton width="100%" height={38} radius="lg" />
        </div>
      </Section>

      <Section title="Dialog">
        <Dialog
          trigger={<Button>仕事を頼む</Button>}
          title="仕事を頼む"
          description="ゴールを一行で書く。Esc で閉じ、focus は trigger に戻る。"
          footer={<Button>開始</Button>}
        >
          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor="gallery-goal" style={{ fontSize: 12, color: "var(--text-2)" }}>
              ゴール
            </label>
            <input
              id="gallery-goal"
              placeholder="例: 0102 の App shell を作る"
              style={{
                height: 30,
                padding: "0 8px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--surface)",
                color: "var(--text)",
              }}
            />
          </div>
        </Dialog>
      </Section>

      <Section title="Menu">
        <Menu
          label="操作"
          trigger={<Button variant="ghost">操作</Button>}
          items={[
            { label: "改名", shortcut: "R", onSelect: () => setToast("改名を選んだ") },
            { label: "複製", shortcut: "D", onSelect: () => setToast("複製を選んだ") },
            { label: "アーカイブ", disabled: true, onSelect: () => setToast("起きない") },
            { label: "削除", danger: true, onSelect: () => setToast("削除を選んだ") },
          ]}
        />
      </Section>

      <Section title="Toast">
        <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
          <Toast
            message="削除しました"
            action={{ label: "元に戻す", onSelect: () => setToast("Undo") }}
            onDismiss={() => setToast("dismiss")}
          />
          <Toast tone="error" message="保存に失敗しました" />
          {toast === null ? null : (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)" }}>last: {toast}</p>
          )}
        </div>
      </Section>

      <Section title="Keyboard">
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-2)" }}>
          Tab で移動し、focus ring を見る。Dialog は Esc、Menu は Enter → 矢印 → Enter、Escape。
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 13, color: "var(--text-2)", fontWeight: 600 }}>{title}</h2>
      {children}
    </section>
  );
}

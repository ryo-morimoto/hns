import { Component, Suspense, type ReactElement, type ReactNode } from "react";
import { Skeleton } from "../components/Skeleton.tsx";

/** The shell while the first Relay read is in flight. */
function ShellFallback(): ReactElement {
  return (
    <div className="hns-shell" data-panel="closed">
      <main className="hns-shell__main">
        <section className="hns-view" aria-label="読み込み中">
          <Skeleton width={220} height={18} />
          <Skeleton width={320} height={12} />
        </section>
      </main>
    </div>
  );
}

/** The shell when a read failed; the details stay in the console, not the page. */
function ShellFailure(): ReactElement {
  return (
    <div className="hns-shell" data-panel="closed" data-render-error="true">
      <main className="hns-shell__main">
        <section className="hns-view">
          <h1>読み込めません</h1>
          <p className="hns-view__note">接続を確かめて、読み込み直してください。</p>
          <button type="button" className="hns-view__link" onClick={() => window.location.reload()}>
            読み込み直す
          </button>
        </section>
      </main>
    </div>
  );
}

interface BoundaryProps {
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly failed: boolean;
}

/**
 * Render the failure screen when a suspended read throws.
 *
 * @remarks
 * Relay throws on a failed read, so without a boundary the whole tree unmounts. The boundary is
 * above the shell's Suspense so both loading and failure are answered.
 */
export class QueryBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) return <ShellFailure />;
    return <Suspense fallback={<ShellFallback />}>{this.props.children}</Suspense>;
  }
}

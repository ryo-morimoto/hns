import { useCallback, useEffect, useRef, useState } from "react";
import type { Environment, FetchPolicy } from "relay-runtime";

/**
 * The policy every screen starts from: answer from the store, and go to the network only when
 * the store cannot answer.
 *
 * @remarks
 * This is Relay's default and the app's (D097). A screen leaves it only by listing itself in
 * {@link FRESHNESS}, and the departure has to say why.
 */
export const DEFAULT_FETCH_POLICY = "store-or-network" as const;

/** The screens whose freshness the app decides. */
export const FRESHNESS_SCREENS = ["projects", "workspace", "conversation"] as const;

/** One screen name from {@link FRESHNESS_SCREENS}. */
export type FreshnessScreen = (typeof FRESHNESS_SCREENS)[number];

/**
 * How long a screen that changes slowly is answered from the store.
 *
 * @remarks
 * Settings, providers, and machines reuse this window when those screens are built (D097).
 * The project list is the screen that uses it today.
 */
export const SLOW_SCREEN_TTL_MS = 30_000;

/**
 * How one screen keeps its data fresh, when it does not accept the default.
 *
 * @remarks
 * Every entry is a departure from {@link DEFAULT_FETCH_POLICY}, so `reason` is required: a
 * screen that shows a stale list without saying why is a decision, and the decision belongs
 * next to the policy. `ttlMs` is the window in which the store answers alone; once it has
 * passed, the next mount or focus reads the network again.
 *
 * A screen that subscribes or reads the network on every mount has no need for a TTL; one that
 * has neither but also no TTL would never revalidate, and the table test refuses that shape.
 */
export interface FreshnessPolicy {
  /**
   * The policy a read uses once the store copy is too old to trust.
   *
   * @remarks
   * `store-only` is excluded: with an empty or collected record the read would never finish.
   */
  readonly fetchPolicy: Exclude<FetchPolicy, typeof DEFAULT_FETCH_POLICY | "store-only">;
  /** How long the store answers alone, in milliseconds; null means every mount reads the network. */
  readonly ttlMs: number | null;
  /** Whether the screen holds a live subscription that patches the store (0159). */
  readonly subscribes: boolean;
  /** Why this screen departs from the default. Required: a departure is a decision. */
  readonly reason: string;
}

/**
 * The screen-to-policy table; the one place a screen's freshness is decided (D097).
 *
 * @remarks
 * - `projects`: no live channel carries a project's creation or rename (0159 subscribes per
 *   conversation), so a revisit is answered from the store inside the TTL and revalidated after
 *   it or when the tab regains focus.
 * - `workspace`: the conversation and task lists feed Needs you, so a stale copy misleads. No
 *   live channel carries the lists themselves (a list subscription needs a server and protocol
 *   change), so each mount reads the network while the store stays on screen. The open
 *   conversation's title is still live: its socket patches the list record. A reconnect
 *   refetches the lists to pick up what the socket cannot carry.
 * - `conversation`: the transcript is followed by a cursor. A store copy has no cursor, so lost
 *   frames cannot be filled in from it; the read is always the network's and the socket keeps it
 *   current.
 */
export const FRESHNESS: Record<FreshnessScreen, FreshnessPolicy> = {
  projects: {
    fetchPolicy: "store-and-network",
    ttlMs: SLOW_SCREEN_TTL_MS,
    subscribes: false,
    reason:
      "プロジェクトの追加・改名を運ぶライブ配信が無い（0159 は会話単位）。開くたびに問い合わせると RPC だけが増えるので、30 秒は store で答え、過ぎたら network も走らせる。",
  },
  workspace: {
    fetchPolicy: "store-and-network",
    ttlMs: null,
    subscribes: false,
    reason:
      "会話とタスクの一覧は Needs you の判断に使うので、古いまま出すと判断を誤る。一覧を運ぶライブ配信は無い（0159 は会話単位。一覧の購読は server / protocol の拡張が要る）ので、store を見せたまま開くたびに network で読み直し、切断中に増えた会話は再接続の refetch で拾う。",
  },
  conversation: {
    fetchPolicy: "network-only",
    ttlMs: null,
    subscribes: true,
    reason:
      "transcript は cursor で追う live view で、store の版は cursor を持たない。取りこぼしを差分で埋められないので store を正本にせず、毎回 network から取って以後は WS で更新する。",
  },
};

/** What a screen knows about its last network read. */
export interface FreshnessReading {
  /** When the last network read in this environment was recorded; undefined when it never ran here. */
  readonly lastFetchedAt: number | undefined;
  /** Now, in epoch milliseconds. */
  readonly now: number;
}

/**
 * The policy the next read of a screen mounts with.
 *
 * @param screen - The screen; it selects the entry from {@link FRESHNESS}.
 * @param reading - When the screen last used the network in this environment, and now.
 * @returns `store-or-network` inside the TTL window, otherwise the screen's own policy.
 *
 * @remarks
 * The window is half-open: exactly `ttlMs` after the last read counts as expired, so a screen
 * does not need to wait for the clock to tick past the boundary. A screen without a TTL or
 * without a recorded read always uses its own policy.
 */
export function fetchPolicyFor(screen: FreshnessScreen, reading: FreshnessReading): FetchPolicy {
  const policy = FRESHNESS[screen];
  if (policy.ttlMs === null || reading.lastFetchedAt === undefined) return policy.fetchPolicy;
  return reading.now - reading.lastFetchedAt < policy.ttlMs
    ? DEFAULT_FETCH_POLICY
    : policy.fetchPolicy;
}

/** Whether a screen holds a live subscription; the conversation screen is the only one today. */
export function subscribesToLive(screen: FreshnessScreen): boolean {
  return FRESHNESS[screen].subscribes;
}

/** The last network read per screen, per environment; a new environment (and a test) starts empty. */
const lastReads = new WeakMap<Environment, Map<FreshnessScreen, number>>();

/** The read times of one environment, created on first use. */
function readsOf(environment: Environment): Map<FreshnessScreen, number> {
  const existing = lastReads.get(environment);
  if (existing !== undefined) return existing;
  const created = new Map<FreshnessScreen, number>();
  lastReads.set(environment, created);
  return created;
}

/** What a TTL screen passes to {@link useScreenRead} so it can revalidate itself. */
export interface ScreenReadOptions {
  /**
   * Run the screen's read again, writing into the same store.
   *
   * @remarks
   * The hook cannot know a query and its variables, so a TTL screen supplies the read. A
   * rejection leaves the window stale, which makes the next focus read again instead of waiting
   * out a window that never succeeded.
   */
  readonly revalidate?: (() => Promise<void>) | undefined;
}

/**
 * Apply one screen's freshness policy to the Relay read it is about to run.
 *
 * @param environment - The Relay environment whose store answers the read.
 * @param screen - The screen; it selects the entry from {@link FRESHNESS}.
 * @param options - The revalidation read for a screen with a TTL.
 * @returns The `fetchPolicy` for the screen's `useLazyLoadQuery`.
 *
 * @remarks
 * The window is recorded once a read that went to the network is on screen: the component does
 * not commit while that read is in flight, so a failed first read registers nothing and the next
 * visit asks again. A TTL screen also revalidates when the tab returns to the foreground, and
 * records the window only after that read succeeds; a failure is retried on the next focus. No
 * screen polls.
 *
 * A caller may override the returned policy for a case the table does not cover (the shell keeps
 * the default while no project is selected, so an empty request never leaves). The screen still
 * records the mount; a screen without a TTL never reads that record, so nothing changes.
 */
export function useScreenRead(
  environment: Environment,
  screen: FreshnessScreen,
  options: ScreenReadOptions = {},
): FetchPolicy {
  const policy = FRESHNESS[screen];
  const revalidate = options.revalidate;
  const [fetchPolicy] = useState<FetchPolicy>(() =>
    fetchPolicyFor(screen, { lastFetchedAt: readsOf(environment).get(screen), now: Date.now() }),
  );
  const startedWith = useRef(fetchPolicy);
  const inFlight = useRef(false);

  // Mounting starts the window when the read is on screen, not when its request is dispatched.
  useEffect(() => {
    if (startedWith.current !== DEFAULT_FETCH_POLICY) readsOf(environment).set(screen, Date.now());
  }, [environment, screen]);

  const reread = useCallback((): void => {
    if (inFlight.current) return;
    const ttl = policy.ttlMs;
    if (ttl === null || revalidate === undefined) return;
    const last = readsOf(environment).get(screen);
    const now = Date.now();
    if (last !== undefined && now - last < ttl) return;
    inFlight.current = true;
    void revalidate()
      .then(() => {
        readsOf(environment).set(screen, Date.now());
      })
      .catch(() => {
        // The window stays stale, so the next focus reads again; the screen keeps what it shows.
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [environment, policy, screen, revalidate]);

  useEffect(() => {
    if (policy.ttlMs === null) return;
    const rereadWhenVisible = (): void => {
      if (document.visibilityState === "hidden") return;
      reread();
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", rereadWhenVisible);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", rereadWhenVisible);
    };
  }, [policy, reread]);

  return fetchPolicy;
}

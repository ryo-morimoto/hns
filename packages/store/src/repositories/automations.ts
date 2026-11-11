import * as v from "valibot";
import {
  type Automation,
  type AutomationAction,
  type AutomationFiringStatus,
  type AutomationTrigger,
  type Firing,
  type ProjectId,
} from "@hns/core";
import type { IsoTimestamp } from "@hns/core";
import { IsoTimestampSchema } from "@hns/core";
import { AutomationActionSchema, AutomationTriggerSchema } from "../schemas.ts";
import type { StoreContext } from "../db.ts";
import { parseAutomation, parseFiring } from "../parse.ts";

/**
 * Input for {@link AutomationRepository.create}.
 *
 * @remarks
 * A webhook trigger without a token gets a generated one; `enabled` defaults to true.
 */
export interface AutomationCreateInput {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly enabled?: boolean | undefined;
}

/**
 * Automations and their firings.
 *
 * @remarks
 * Trigger and action are validated before writing, and a webhook token is generated on
 * create when absent. A token is unique across automations. Missing rows return `undefined`,
 * `delete` reports whether a row was removed, and each write is one statement.
 */
export interface AutomationRepository {
  /** Automations across every project, or only `projectId`; oldest first. */
  list(projectId?: ProjectId | undefined): Promise<Automation[]>;
  /** The automation with `id`, or `undefined` when it does not exist. */
  get(id: string): Promise<Automation | undefined>;
  /** The webhook automation with `token`, or `undefined` when none has it. */
  getByToken(token: string): Promise<Automation | undefined>;
  /**
   * Create an automation.
   *
   * @remarks
   * The trigger and action are validated before the write. A webhook trigger without a token
   * gets one derived from a fresh id.
   *
   * @throws ValiError if `trigger` or `action` is invalid.
   * @throws Error if the token collides or the row is missing after the write.
   */
  create(input: AutomationCreateInput): Promise<Automation>;
  /**
   * Update the given fields, keeping the rest.
   *
   * @remarks
   * Trigger and action are re-validated when supplied. A webhook trigger keeps its existing
   * token unless the patch supplies one; a trigger that changes to webhook gets a generated
   * token. `undefined` when the automation does not exist.
   *
   * @throws ValiError if a supplied trigger or action is invalid.
   */
  update(
    id: string,
    patch: Partial<Pick<Automation, "name" | "trigger" | "action" | "enabled">>,
  ): Promise<Automation | undefined>;
  /** Delete an automation and, by cascade, its firings; returns whether a row was removed. */
  delete(id: string): Promise<boolean>;
  /** Record when a scheduled automation last fired; a no-op when the automation is missing. */
  setLastFiredAt(id: string, at: IsoTimestamp): Promise<void>;
  /**
   * Record an attempt to run an automation.
   *
   * @remarks
   * `detail` and `runId` are null when omitted. The repository does not enforce firing
   * transitions; the caller supplies the status.
   */
  createFiring(input: {
    automationId: string;
    at: IsoTimestamp;
    status: AutomationFiringStatus;
    detail?: string | undefined;
    runId?: string | undefined;
  }): Promise<Firing>;
  /**
   * Update a firing's status and, when supplied, its detail and run.
   *
   * @remarks
   * An omitted `detail` or `runId` keeps the stored value. `undefined` when the firing does
   * not exist.
   */
  updateFiring(
    id: string,
    patch: {
      status: AutomationFiringStatus;
      detail?: string | undefined;
      runId?: string | undefined;
    },
  ): Promise<Firing | undefined>;
  /** The firing with `id`, or `undefined` when it does not exist. */
  getFiring(id: string): Promise<Firing | undefined>;
  /** Firings of `automationId`, newest first. */
  listFirings(automationId: string): Promise<Firing[]>;
}

/**
 * Build the automation repository over `context`.
 *
 * @internal
 */
export function automationRepository(context: StoreContext): AutomationRepository {
  const { sql, now, newId } = context;

  const get = async (id: string): Promise<Automation | undefined> => {
    const row = await sql.get("SELECT * FROM automations WHERE id = ?", [id]);
    return row === undefined ? undefined : parseAutomation(row);
  };

  const getFiring = async (id: string): Promise<Firing | undefined> => {
    const row = await sql.get("SELECT * FROM firings WHERE id = ?", [id]);
    return row === undefined ? undefined : parseFiring(row);
  };

  return {
    async list(projectId) {
      const rows =
        projectId === undefined
          ? await sql.all("SELECT * FROM automations ORDER BY created_at")
          : await sql.all("SELECT * FROM automations WHERE project_id = ? ORDER BY created_at", [
              projectId,
            ]);
      return rows.map((row) => parseAutomation(row));
    },
    get,
    async getByToken(token) {
      const row = await sql.get("SELECT * FROM automations WHERE token = ?", [token]);
      return row === undefined ? undefined : parseAutomation(row);
    },
    async create(input) {
      const trigger = v.parse(AutomationTriggerSchema, input.trigger);
      const action = v.parse(AutomationActionSchema, input.action);
      const withToken =
        trigger.type === "webhook" && trigger.token === undefined
          ? { ...trigger, token: newId().replaceAll("-", "") }
          : trigger;
      const token = withToken.type === "webhook" ? (withToken.token ?? null) : null;
      const createdAt = now();
      const row = await sql.get(
        "INSERT INTO automations (id, project_id, name, trigger_json, action_json, token, enabled, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        [
          newId(),
          input.projectId,
          input.name,
          JSON.stringify(withToken),
          JSON.stringify(action),
          token,
          input.enabled === false ? 0 : 1,
          createdAt,
          createdAt,
        ],
      );
      if (row === undefined) throw new Error("automation was not created");
      return parseAutomation(row);
    },
    async update(id, patch) {
      const current = await get(id);
      if (current === undefined) return undefined;
      const trigger =
        patch.trigger === undefined
          ? current.trigger
          : v.parse(AutomationTriggerSchema, patch.trigger);
      const action =
        patch.action === undefined ? current.action : v.parse(AutomationActionSchema, patch.action);
      const keptToken = current.trigger.type === "webhook" ? current.trigger.token : undefined;
      const token =
        trigger.type === "webhook"
          ? (trigger.token ?? keptToken ?? newId().replaceAll("-", ""))
          : null;
      const withToken =
        trigger.type === "webhook" && trigger.token === undefined ? { ...trigger, token } : trigger;
      const row = await sql.get(
        "UPDATE automations SET name = ?, enabled = ?, trigger_json = ?, action_json = ?, token = ?, updated_at = ? " +
          "WHERE id = ? RETURNING *",
        [
          patch.name ?? current.name,
          patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
          JSON.stringify(withToken),
          JSON.stringify(action),
          token,
          now(),
          id,
        ],
      );
      return row === undefined ? undefined : parseAutomation(row);
    },
    async delete(id) {
      return (await sql.run("DELETE FROM automations WHERE id = ?", [id])) > 0;
    },
    async setLastFiredAt(id, at) {
      const value = v.parse(IsoTimestampSchema, at);
      await sql.run("UPDATE automations SET last_fired_at = ? WHERE id = ?", [value, id]);
    },
    async createFiring(input) {
      const firing = parseFiring({
        id: newId(),
        automation_id: input.automationId,
        at: input.at,
        status: input.status,
        detail: input.detail ?? null,
        run_id: input.runId ?? null,
        created_at: now(),
      });
      const row = await sql.get(
        "INSERT INTO firings (id, automation_id, at, status, detail, run_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
        [
          firing.id,
          firing.automation_id,
          firing.at,
          firing.status,
          firing.detail,
          firing.run_id,
          firing.created_at,
        ],
      );
      if (row === undefined) throw new Error("firing was not created");
      return parseFiring(row);
    },
    async updateFiring(id, patch) {
      const row = await sql.get(
        "UPDATE firings SET status = ?, detail = COALESCE(?, detail), run_id = COALESCE(?, run_id) " +
          "WHERE id = ? RETURNING *",
        [patch.status, patch.detail ?? null, patch.runId ?? null, id],
      );
      return row === undefined ? undefined : parseFiring(row);
    },
    getFiring,
    async listFirings(automationId) {
      const rows = await sql.all(
        "SELECT * FROM firings WHERE automation_id = ? ORDER BY created_at DESC",
        [automationId],
      );
      return rows.map((row) => parseFiring(row));
    },
  };
}

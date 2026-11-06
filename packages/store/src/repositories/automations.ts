import * as v from "valibot";
import {
  AutomationActionSchema,
  AutomationTriggerSchema,
  type Automation,
  type AutomationAction,
  type AutomationFiringStatus,
  type AutomationTrigger,
  type AutomationUpdate,
  type Firing,
  type ProjectId,
} from "@hns/core";
import type { IsoTimestamp } from "@hns/core";
import { IsoTimestampSchema } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseAutomation, parseFiring } from "../parse.ts";

export interface AutomationCreateInput {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly enabled?: boolean | undefined;
}

export interface AutomationRepository {
  list(projectId?: ProjectId | undefined): Automation[];
  get(id: string): Automation | undefined;
  getByToken(token: string): Automation | undefined;
  create(input: AutomationCreateInput): Automation;
  update(id: string, patch: AutomationUpdate): Automation | undefined;
  delete(id: string): boolean;
  setLastFiredAt(id: string, at: IsoTimestamp): void;
  createFiring(input: {
    automationId: string;
    at: IsoTimestamp;
    status: AutomationFiringStatus;
    detail?: string | undefined;
    runId?: string | undefined;
  }): Firing;
  updateFiring(
    id: string,
    patch: {
      status: AutomationFiringStatus;
      detail?: string | undefined;
      runId?: string | undefined;
    },
  ): Firing | undefined;
  getFiring(id: string): Firing | undefined;
  listFirings(automationId: string): Firing[];
}

export function automationRepository(context: StoreContext): AutomationRepository {
  const { db, now, newId, transaction } = context;

  const get = (id: string): Automation | undefined => {
    const row = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
    return row === undefined ? undefined : parseAutomation(row);
  };

  const getFiring = (id: string): Firing | undefined => {
    const row = db.prepare("SELECT * FROM firings WHERE id = ?").get(id);
    return row === undefined ? undefined : parseFiring(row);
  };

  return {
    list(projectId) {
      const rows =
        projectId === undefined
          ? db.prepare("SELECT * FROM automations ORDER BY created_at").all()
          : db
              .prepare("SELECT * FROM automations WHERE project_id = ? ORDER BY created_at")
              .all(projectId);
      return rows.map((row) => parseAutomation(row));
    },
    get,
    getByToken(token) {
      const row = db.prepare("SELECT * FROM automations WHERE token = ?").get(token);
      return row === undefined ? undefined : parseAutomation(row);
    },
    create(input) {
      const trigger = v.parse(AutomationTriggerSchema, input.trigger);
      const action = v.parse(AutomationActionSchema, input.action);
      const withToken =
        trigger.type === "webhook" && trigger.token === undefined
          ? { ...trigger, token: newId().replaceAll("-", "") }
          : trigger;
      const token = withToken.type === "webhook" ? (withToken.token ?? null) : null;
      const createdAt = now();
      const id = newId();
      transaction(() => {
        db.prepare(
          "INSERT INTO automations (id, project_id, name, trigger_json, action_json, token, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          input.projectId,
          input.name,
          JSON.stringify(withToken),
          JSON.stringify(action),
          token,
          input.enabled === false ? 0 : 1,
          createdAt,
          createdAt,
        );
      });
      const automation = get(id);
      if (automation === undefined) throw new Error("automation was not created");
      return automation;
    },
    update(id, patch) {
      const current = get(id);
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
      transaction(() => {
        db.prepare(
          "UPDATE automations SET name = ?, enabled = ?, trigger_json = ?, action_json = ?, token = ?, updated_at = ? WHERE id = ?",
        ).run(
          patch.name ?? current.name,
          patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
          JSON.stringify(withToken),
          JSON.stringify(action),
          token,
          now(),
          id,
        );
      });
      return get(id);
    },
    delete(id) {
      return transaction(() => {
        const result = db.prepare("DELETE FROM automations WHERE id = ?").run(id);
        return Number(result.changes) > 0;
      });
    },
    setLastFiredAt(id, at) {
      const value = v.parse(IsoTimestampSchema, at);
      transaction(() => {
        db.prepare("UPDATE automations SET last_fired_at = ? WHERE id = ?").run(value, id);
      });
    },
    createFiring(input) {
      const firing = parseFiring({
        id: newId(),
        automation_id: input.automationId,
        at: input.at,
        status: input.status,
        detail: input.detail ?? null,
        run_id: input.runId ?? null,
        created_at: now(),
      });
      transaction(() => {
        db.prepare(
          "INSERT INTO firings (id, automation_id, at, status, detail, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          firing.id,
          firing.automation_id,
          firing.at,
          firing.status,
          firing.detail,
          firing.run_id,
          firing.created_at,
        );
      });
      return firing;
    },
    updateFiring(id, patch) {
      const current = getFiring(id);
      if (current === undefined) return undefined;
      transaction(() => {
        db.prepare(
          "UPDATE firings SET status = ?, detail = COALESCE(?, detail), run_id = COALESCE(?, run_id) WHERE id = ?",
        ).run(patch.status, patch.detail ?? null, patch.runId ?? null, id);
      });
      return getFiring(id);
    },
    getFiring,
    listFirings(automationId) {
      return db
        .prepare("SELECT * FROM firings WHERE automation_id = ? ORDER BY created_at DESC")
        .all(automationId)
        .map((row) => parseFiring(row));
    },
  };
}

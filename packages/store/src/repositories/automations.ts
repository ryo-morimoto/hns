import type { Automation, Firing, ProjectId } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseAutomation, parseFiring } from "../parse.ts";

/**
 * Automations and their firings.
 *
 * @remarks
 * The store hands out the read side only: no face creates, edits, or fires an automation yet,
 * so the writes stay out of `Store`. Trigger and action are validated when a write is added
 * here. Missing rows return `undefined`.
 */
export interface AutomationRepository {
  /** Automations across every project, or only `projectId`; oldest first. */
  list(projectId?: ProjectId | undefined): Promise<Automation[]>;
  /** The automation with `id`, or `undefined` when it does not exist. */
  get(id: string): Promise<Automation | undefined>;
  /** The webhook automation with `token`, or `undefined` when none has it. */
  getByToken(token: string): Promise<Automation | undefined>;
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
  const { sql } = context;

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

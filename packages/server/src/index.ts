/**
 * The Worker entrypoint for hns.
 *
 * @remarks
 * The deploy project re-exports this default. Durable Object classes join this entry when
 * the Session and Workspace objects land.
 */
export { default } from "./edge/worker.ts";

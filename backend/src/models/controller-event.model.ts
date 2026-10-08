import type { PoolClient } from "pg";
import pool from "../config/database.ts";

export interface ControllerEventInput {
  commandId?: string | null;
  junctionId: string;
  status: string;
  actualState?: string | null;
}

export interface ControllerEventRow {
  id: number;
  command_id: string | null;
  junction_id: string;
  status: string;
  actual_state: string | null;
  created_at: Date;
}

export async function createControllerEvent(
  event: ControllerEventInput,
  client: PoolClient | typeof pool = pool,
): Promise<ControllerEventRow> {
  const result = await client.query<ControllerEventRow>(
    "INSERT INTO controller_events (command_id, junction_id, status, actual_state) VALUES ($1, $2, $3, $4) RETURNING id, command_id, junction_id, status, actual_state, created_at",
    [event.commandId ?? null, event.junctionId, event.status, event.actualState ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Controller event insert returned no row");
  return row;
}

export async function listControllerEvents(
  junctionId: string,
  limit = 100,
  client: PoolClient | typeof pool = pool,
): Promise<ControllerEventRow[]> {
  const result = await client.query<ControllerEventRow>(
    "SELECT id, command_id, junction_id, status, actual_state, created_at FROM controller_events WHERE junction_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
    [junctionId, limit],
  );
  return result.rows;
}
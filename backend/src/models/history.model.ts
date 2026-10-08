import type { PoolClient } from "pg";
import pool from "../config/database.ts";

export interface AuditLogInput {
  junctionId: string;
  eventType: string;
  direction?: string | null;
  previousState?: string | null;
  newState?: string | null;
  commandId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AuditLogRow {
  id: number;
  junction_id: string;
  event_type: string;
  direction: string | null;
  previous_state: string | null;
  new_state: string | null;
  command_id: string | null;
  details: Record<string, unknown> | null;
  created_at: Date;
}

export async function appendHistory(
  entry: AuditLogInput,
  client: PoolClient | typeof pool = pool,
): Promise<AuditLogRow> {
  const result = await client.query<AuditLogRow>(
    "INSERT INTO audit_logs (junction_id, event_type, direction, previous_state, new_state, command_id, details) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id, junction_id, event_type, direction, previous_state, new_state, command_id, details, created_at",
    [
      entry.junctionId,
      entry.eventType,
      entry.direction ?? null,
      entry.previousState ?? null,
      entry.newState ?? null,
      entry.commandId ?? null,
      entry.details === undefined || entry.details === null ? null : JSON.stringify(entry.details),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("History insert returned no row");
  return row;
}

export async function getHistory(
  junctionId: string,
  limit = 100,
  client: PoolClient | typeof pool = pool,
): Promise<AuditLogRow[]> {
  const result = await client.query<AuditLogRow>(
    "SELECT id, junction_id, event_type, direction, previous_state, new_state, command_id, details, created_at FROM audit_logs WHERE junction_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
    [junctionId, limit],
  );
  return result.rows;
}
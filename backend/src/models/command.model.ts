import type { PoolClient } from "pg";
import pool from "../config/database.ts";

export interface TrafficCommandInput {
  commandId: string;
  junctionId: string;
  command: string;
  direction?: string | null;
  requestedState?: string | null;
  status?: string;
}

export interface TrafficCommandRow {
  id: number;
  command_id: string;
  junction_id: string;
  command: string;
  direction: string | null;
  requested_state: string | null;
  status: string;
  created_at: Date;
  acknowledged_at: Date | null;
}

export async function createCommand(
  command: TrafficCommandInput,
  client: PoolClient | typeof pool = pool,
): Promise<TrafficCommandRow> {
  const result = await client.query<TrafficCommandRow>(
    "INSERT INTO traffic_commands (command_id, junction_id, command, direction, requested_state, status) VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'PENDING')) RETURNING id, command_id, junction_id, command, direction, requested_state, status, created_at, acknowledged_at",
    [
      command.commandId,
      command.junctionId,
      command.command,
      command.direction ?? null,
      command.requestedState ?? null,
      command.status ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Command insert returned no row");
  return row;
}

export async function getCommandById(
  commandId: string,
  client: PoolClient | typeof pool = pool,
): Promise<TrafficCommandRow | undefined> {
  const result = await client.query<TrafficCommandRow>(
    "SELECT id, command_id, junction_id, command, direction, requested_state, status, created_at, acknowledged_at FROM traffic_commands WHERE command_id = $1",
    [commandId],
  );
  return result.rows[0];
}

export async function listCommands(
  junctionId: string,
  limit = 100,
  client: PoolClient | typeof pool = pool,
): Promise<TrafficCommandRow[]> {
  const result = await client.query<TrafficCommandRow>(
    "SELECT id, command_id, junction_id, command, direction, requested_state, status, created_at, acknowledged_at FROM traffic_commands WHERE junction_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
    [junctionId, limit],
  );
  return result.rows;
}

export async function updateCommandStatus(
  commandId: string,
  status: string,
  acknowledged: boolean,
  client: PoolClient | typeof pool = pool,
): Promise<TrafficCommandRow | undefined> {
  const result = await client.query<TrafficCommandRow>(
    "UPDATE traffic_commands SET status = $2, acknowledged_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE acknowledged_at END WHERE command_id = $1 RETURNING id, command_id, junction_id, command, direction, requested_state, status, created_at, acknowledged_at",
    [commandId, status, acknowledged],
  );
  return result.rows[0];
}

export async function supersedePendingCommands(
  client: PoolClient,
  junctionId: string,
): Promise<number> {
  const result = await client.query(
    "UPDATE traffic_commands SET status = 'SUPERSEDED' WHERE junction_id = $1 AND status = 'PENDING'",
    [junctionId],
  );
  return result.rowCount ?? 0;
}

export async function getPendingCommands(
  client: PoolClient | typeof pool = pool,
): Promise<TrafficCommandRow[]> {
  const result = await client.query<TrafficCommandRow>(
    "SELECT id, command_id, junction_id, command, direction, requested_state, status, created_at, acknowledged_at FROM traffic_commands WHERE status = 'PENDING' ORDER BY id ASC",
  );
  return result.rows;
}
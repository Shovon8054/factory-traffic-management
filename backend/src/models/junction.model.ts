import type { PoolClient } from "pg";
import pool from "../config/database.ts";

export interface JunctionRow {
  id: string;
  name: string;
  mode: string;
  current_phase: string;
  controller_status: string;
  created_at: Date;
  updated_at: Date;
}

export interface JunctionQueueRow {
  junction_id: string;
  direction: string;
  queue_count: number;
  updated_at: Date;
}

export async function getJunctionById(
  junctionId: string,
  client: PoolClient | typeof pool = pool,
): Promise<JunctionRow | undefined> {
  const result = await client.query<JunctionRow>(
    "SELECT id, name, mode, current_phase, controller_status, created_at, updated_at FROM junctions WHERE id = $1",
    [junctionId],
  );
  return result.rows[0];
}

export async function listJunctions(
  client: PoolClient | typeof pool = pool,
): Promise<JunctionRow[]> {
  const result = await client.query<JunctionRow>(
    "SELECT id, name, mode, current_phase, controller_status, created_at, updated_at FROM junctions ORDER BY id",
  );
  return result.rows;
}

export async function lockJunction(
  client: PoolClient,
  junctionId: string,
): Promise<JunctionRow | undefined> {
  const result = await client.query<JunctionRow>(
    "SELECT id, name, mode, current_phase, controller_status, created_at, updated_at FROM junctions WHERE id = $1 FOR UPDATE",
    [junctionId],
  );
  return result.rows[0];
}

export async function getQueues(
  junctionId: string,
  client: PoolClient | typeof pool = pool,
): Promise<JunctionQueueRow[]> {
  const result = await client.query<JunctionQueueRow>(
    "SELECT junction_id, direction, queue_count, updated_at FROM junction_queues WHERE junction_id = $1 ORDER BY direction",
    [junctionId],
  );
  return result.rows;
}

export async function updateQueueCount(
  client: PoolClient,
  junctionId: string,
  direction: string,
  delta: number,
): Promise<JunctionQueueRow | undefined> {
  const result = await client.query<JunctionQueueRow>(
    "UPDATE junction_queues SET queue_count = GREATEST(queue_count + $3, 0), updated_at = CURRENT_TIMESTAMP WHERE junction_id = $1 AND direction = $2 RETURNING junction_id, direction, queue_count, updated_at",
    [junctionId, direction, delta],
  );
  return result.rows[0];
}

export async function updateJunctionState(
  client: PoolClient,
  junctionId: string,
  mode: string,
  currentPhase: string,
  controllerStatus: string,
): Promise<JunctionRow | undefined> {
  const result = await client.query<JunctionRow>(
    "UPDATE junctions SET mode = $2, current_phase = $3, controller_status = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, name, mode, current_phase, controller_status, created_at, updated_at",
    [junctionId, mode, currentPhase, controllerStatus],
  );
  return result.rows[0];
}

export async function createJunction(
  client: PoolClient,
  junctionId: string,
  name: string,
): Promise<JunctionRow> {
  const result = await client.query<JunctionRow>(
    "INSERT INTO junctions (id, name) VALUES ($1, $2) RETURNING id, name, mode, current_phase, controller_status, created_at, updated_at",
    [junctionId, name],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Junction insert returned no row");
  return row;
}
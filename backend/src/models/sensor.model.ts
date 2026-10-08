import type { PoolClient } from "pg";
import pool from "../config/database.ts";

export interface SensorEventInput {
  eventId: string;
  junctionId: string;
  direction: string;
  eventType: string;
  vehicleId?: string | null;
  vehicleType?: string | null;
  sequenceNo?: number | null;
  sensorTimestamp?: Date | null;
  status?: string;
}

export interface SensorEventRow {
  id: number;
  event_id: string;
  junction_id: string;
  direction: string;
  event_type: string;
  vehicle_id: string | null;
  vehicle_type: string | null;
  sequence_no: number | null;
  sensor_timestamp: Date | null;
  received_at: Date;
  status: string;
}

export interface ActiveSensorVehicleRow {
  vehicle_id: string;
  direction: string;
  vehicle_type: string | null;
  sensor_timestamp: Date | null;
  received_at: Date;
}

export async function insertSensorEvent(
  event: SensorEventInput,
  client: PoolClient | typeof pool = pool,
): Promise<SensorEventRow | undefined> {
  const result = await client.query<SensorEventRow>(
    "INSERT INTO sensor_events (event_id, junction_id, direction, event_type, vehicle_id, vehicle_type, sequence_no, sensor_timestamp, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'PROCESSED')) ON CONFLICT (event_id) DO NOTHING RETURNING id, event_id, junction_id, direction, event_type, vehicle_id, vehicle_type, sequence_no, sensor_timestamp, received_at, status",
    [
      event.eventId,
      event.junctionId,
      event.direction,
      event.eventType,
      event.vehicleId ?? null,
      event.vehicleType ?? null,
      event.sequenceNo ?? null,
      event.sensorTimestamp ?? null,
      event.status ?? null,
    ],
  );
  return result.rows[0];
}

export async function getSensorEventById(
  eventId: string,
  client: PoolClient | typeof pool = pool,
): Promise<SensorEventRow | undefined> {
  const result = await client.query<SensorEventRow>(
    "SELECT id, event_id, junction_id, direction, event_type, vehicle_id, vehicle_type, sequence_no, sensor_timestamp, received_at, status FROM sensor_events WHERE event_id = $1",
    [eventId],
  );
  return result.rows[0];
}

export async function updateSensorEventStatus(
  eventId: string,
  status: string,
  client: PoolClient | typeof pool = pool,
): Promise<SensorEventRow | undefined> {
  const result = await client.query<SensorEventRow>(
    "UPDATE sensor_events SET status = $2 WHERE event_id = $1 RETURNING id, event_id, junction_id, direction, event_type, vehicle_id, vehicle_type, sequence_no, sensor_timestamp, received_at, status",
    [eventId, status],
  );
  return result.rows[0];
}

export async function listSensorEvents(
  junctionId: string,
  limit = 100,
  client: PoolClient | typeof pool = pool,
): Promise<SensorEventRow[]> {
  const result = await client.query<SensorEventRow>(
    "SELECT id, event_id, junction_id, direction, event_type, vehicle_id, vehicle_type, sequence_no, sensor_timestamp, received_at, status FROM sensor_events WHERE junction_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2",
    [junctionId, limit],
  );
  return result.rows;
}

export async function getLatestSensorSequence(
  junctionId: string,
  direction: string,
  client: PoolClient | typeof pool = pool,
): Promise<number | null> {
  const result = await client.query<{ sequence_no: number | null }>(
    "SELECT sequence_no FROM sensor_events WHERE junction_id = $1 AND direction = $2 AND sequence_no IS NOT NULL AND status = 'PROCESSED' ORDER BY sequence_no DESC LIMIT 1",
    [junctionId, direction],
  );
  return result.rows[0]?.sequence_no ?? null;
}

export async function getLatestSensorTimestamp(
  junctionId: string,
  direction: string,
  client: PoolClient | typeof pool = pool,
): Promise<Date | null> {
  const result = await client.query<{ sensor_timestamp: Date | null }>(
    "SELECT sensor_timestamp FROM sensor_events WHERE junction_id = $1 AND direction = $2 AND sensor_timestamp IS NOT NULL AND status = 'PROCESSED' ORDER BY sensor_timestamp DESC LIMIT 1",
    [junctionId, direction],
  );
  return result.rows[0]?.sensor_timestamp ?? null;
}

export async function getActiveSensorVehicles(
  junctionId: string,
  client: PoolClient | typeof pool = pool,
): Promise<ActiveSensorVehicleRow[]> {
  const result = await client.query<ActiveSensorVehicleRow>(
    "WITH latest_vehicle_events AS (SELECT DISTINCT ON (vehicle_id) vehicle_id, direction, vehicle_type, event_type, sensor_timestamp, received_at FROM sensor_events WHERE junction_id = $1 AND vehicle_id IS NOT NULL AND status = 'PROCESSED' ORDER BY vehicle_id, COALESCE(sensor_timestamp, received_at) DESC, id DESC) SELECT vehicle_id, direction, vehicle_type, sensor_timestamp, received_at FROM latest_vehicle_events WHERE event_type IN ('ARRIVED', 'VEHICLE_ARRIVED') ORDER BY direction, COALESCE(sensor_timestamp, received_at), vehicle_id",
    [junctionId],
  );
  return result.rows;
}
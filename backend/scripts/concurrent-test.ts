import request from 'supertest';
import { randomUUID } from 'crypto';
import assert from 'assert';

// Assumes backend dev server already running on process.env.PORT or default 5000
const apiPort = process.env.PORT || '5000';
const apiBase = `http://127.0.0.1:${apiPort}/api`;

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runIteration(iter: number) {
  const emergencyId = `emergency-${iter}-${randomUUID()}`;
  // Prepare concurrent actions
  const truckArrival = request(apiBase)
    .post('/sensor-events')
    .send({
      eventId: `truck-arrival-${iter}-${randomUUID()}`,
      junctionId: 'A',
      direction: 'EAST',
      eventType: 'ARRIVED',
      vehicleId: `truck-${iter}-${randomUUID()}`,
      vehicleType: 'TRUCK',
      sensorTimestamp: new Date().toISOString(),
    });

  const emergencyReq = request(apiBase)
    .post('/commands')
    .send({
      type: 'EMERGENCY_REQUEST',
      junctionId: 'A',
      emergencyId,
      phase: 'EAST_WEST',
      occurredAt: Date.now(),
    });

  const manualWest = request(apiBase)
    .post('/junctions/A/commands')
    .send({ command: 'MANUAL_GREEN_REQUEST', direction: 'WEST' });

  // Duplicate emergency (same emergencyId)
  const duplicateEmergency = request(apiBase)
    .post('/commands')
    .send({
      type: 'EMERGENCY_REQUEST',
      junctionId: 'A',
      emergencyId, // duplicate ID
      phase: 'EAST_WEST',
      occurredAt: Date.now(),
    });

  // Fire all four promises concurrently
  const results = await Promise.all([truckArrival, emergencyReq, manualWest, duplicateEmergency]);

  // Extract manual commandId for ACK via commands list
  await delay(20);
  const cmdsRes = await request(apiBase).get('/commands?junctionId=A&limit=5');
  assert(cmdsRes.status === 200, `Commands list failed with status ${cmdsRes.status}`);
  const pendingCmd = (cmdsRes.body.commands || []).find((c: any) => c.status === 'PENDING');
  assert(pendingCmd?.command_id, 'Pending manual command not found');
  const commandId = pendingCmd.command_id;

  // ACK the manual command shortly after
  await delay(50);
  const ackRes = await request(apiBase)
    .post('/controller-events')
    .send({
      commandId,
      junctionId: 'A',
      status: 'ACKNOWLEDGED',
      actualState: 'GREEN',
    });
  assert(ackRes.status === 201, `ACK failed with status ${ackRes.status}`);
}

async function main() {
  const iterations = 20;
  for (let i = 0; i < iterations; i++) {
    await runIteration(i);
    // Small pause to let state settle before next iteration
    await delay(100);
    // Verify invariant: never more than one GREEN signal
    const statusRes = await request(apiBase).get('/junctions/A/status');
    const signals = statusRes.body.state?.actual?.signals || {};
    const greenCount = Object.values(signals).filter((s) => s === 'GREEN').length;
    assert(greenCount <= 1, `Iteration ${i}: More than one GREEN (${greenCount})`);
  }

  // Final audit check: ensure duplicate emergency IDs did not create extra entries
  const historyRes = await request(apiBase).get('/history?junctionId=A&limit=500');
  const emergencyEvents = (historyRes.body || []).filter((e: any) => e.event_type === 'EMERGENCY_REQUEST');
  const ids = emergencyEvents.map((e: any) => e.details?.emergencyId).filter(Boolean);
  const uniqueIds = new Set(ids);
  if (ids.length !== uniqueIds.size) {
    console.error('Duplicate emergency IDs detected in audit logs');
    process.exit(1);
  }

  console.log('All concurrent iterations completed without invariant violations.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test script error:', err);
  process.exit(1);
});

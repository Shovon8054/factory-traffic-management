import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  assertSafe,
  DEFAULT_JUNCTION_CONFIG,
  decide,
  getPhaseScoreBreakdown,
  type Direction,
  type JunctionState,
  type Mode,
  type Phase,
  type SignalState,
  type TrafficInput,
} from "./traffic.service.ts";

function createState(mode: Mode = "AUTOMATIC"): JunctionState {
  const northSouthGreen: Record<Direction, SignalState> = {
    NORTH: "GREEN",
    SOUTH: "GREEN",
    EAST: "RED",
    WEST: "RED",
  };

  return {
    junctionId: "A",
    mode,
    config: DEFAULT_JUNCTION_CONFIG,
    pendingPhase: null,
    emergencyRequests: [],
    manualOverride: null,
    desired: {
      phase: "NORTH_SOUTH",
      step: "GREEN",
      signals: { ...northSouthGreen },
    },
    actual: {
      phase: "NORTH_SOUTH",
      step: "GREEN",
      signals: { ...northSouthGreen },
      confirmedAt: 0,
    },
    queues: { NORTH: [], SOUTH: [], EAST: [], WEST: [] },
    queueCounts: { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 },
  };
}

function confirmDesired(state: JunctionState, confirmedAt: number): JunctionState {
  return {
    ...state,
    actual: {
      ...state.desired,
      confirmedAt,
    },
  };
}

function schedulerTick(state: JunctionState, now: number, label: string) {
  const scores = getPhaseScoreBreakdown(state);
  const scoreText = scores.map(({ phase, score, contributions }) => {
    const groups = new Map<string, { count: number; weight: number; direction: Direction; vehicleType: string }>();
    for (const { direction, vehicleType, weight } of contributions) {
      const key = `${direction}:${vehicleType}:${weight}`;
      const group = groups.get(key);
      if (group) group.count += 1;
      else groups.set(key, { count: 1, weight, direction, vehicleType });
    }
    const terms = [...groups.values()].map(({ count, direction, vehicleType, weight }) =>
      `${direction}:${count}x${vehicleType}(${weight})=${count * weight}`,
    );
    return `${phase}=${terms.length > 0 ? terms.join("+") : "0"}=${score}`;
  }).join("; ");
  const greenAge = now - state.actual.confirmedAt;
  const result = decide(state, { type: "TICK" }, now);
  console.log(
    `[scheduler-score] ${label}; t=${now}; greenAge=${greenAge}; ${scoreText}; ` +
      `chosen=${result.state.pendingPhase ?? result.state.desired.phase}:${result.state.desired.step}`,
  );
  return result;
}

function addVehicle(
  state: JunctionState,
  direction: Direction,
  vehicleId: string,
  vehicleType: JunctionState["queues"][Direction][number]["type"],
  arrivedAt: number,
): JunctionState {
  return decide(state, {
    type: "VEHICLE_ARRIVED",
    direction,
    vehicleId,
    vehicleType,
  }, arrivedAt).state;
}

describe("decide", () => {
  it("serves the phase with a larger weighted queue after minimum green", () => {
    let state: JunctionState = {
      ...createState(),
      config: { ...DEFAULT_JUNCTION_CONFIG, durations: { ...DEFAULT_JUNCTION_CONFIG.durations, GREEN: 10_000 } },
    };
    state = addVehicle(state, "NORTH", "north-car", "CAR", 0);
    for (let index = 0; index < 4; index += 1) {
      state = addVehicle(state, "EAST", `east-car-${index}`, "CAR", 0);
    }

    const beforeMinimumGreen = schedulerTick(state, 9_999, "larger EAST_WEST queue before minimum green");
    expect(beforeMinimumGreen.state.desired.step).toBe("GREEN");

    const atMinimumGreen = schedulerTick(state, 10_000, "larger EAST_WEST queue at minimum green");
    expect(atMinimumGreen.state.desired.step).toBe("YELLOW");
    expect(atMinimumGreen.state.pendingPhase).toBe("EAST_WEST");
  });

  it("scores TRUCK and FORKLIFT above EMPLOYEE_VEHICLE at equal vehicle counts", () => {
    let state = createState();
    state = addVehicle(state, "NORTH", "employee-1", "EMPLOYEE_VEHICLE", 0);
    state = addVehicle(state, "NORTH", "employee-2", "EMPLOYEE_VEHICLE", 0);
    state = addVehicle(state, "EAST", "truck-1", "TRUCK", 0);
    state = addVehicle(state, "WEST", "forklift-1", "FORKLIFT", 0);

    const breakdown = getPhaseScoreBreakdown(state);
    const northSouth = breakdown.find(({ phase }) => phase === "NORTH_SOUTH")!;
    const eastWest = breakdown.find(({ phase }) => phase === "EAST_WEST")!;
    expect(northSouth.contributions).toHaveLength(2);
    expect(eastWest.contributions).toHaveLength(2);
    expect(northSouth.score).toBe(2 * DEFAULT_JUNCTION_CONFIG.vehiclePriorityWeights.EMPLOYEE_VEHICLE);
    expect(eastWest.score).toBe(
      DEFAULT_JUNCTION_CONFIG.vehiclePriorityWeights.TRUCK +
      DEFAULT_JUNCTION_CONFIG.vehiclePriorityWeights.FORKLIFT,
    );
    const result = schedulerTick(state, DEFAULT_JUNCTION_CONFIG.durations.GREEN, "equal-count truck/forklift vs employee");
    expect(result.state.pendingPhase).toBe("EAST_WEST");
    expect(result.state.desired.step).toBe("YELLOW");
  });

  it("serves a lone starved employee vehicle against a continuous truck stream", () => {
    let state: JunctionState = {
      ...createState(),
      config: {
        ...DEFAULT_JUNCTION_CONFIG,
        durations: { ...DEFAULT_JUNCTION_CONFIG.durations, GREEN: 180_000 },
        maxGreenMs: 180_000,
      },
      desired: {
        phase: "EAST_WEST",
        step: "GREEN",
        signals: { NORTH: "RED", SOUTH: "RED", EAST: "GREEN", WEST: "GREEN" },
      },
      actual: {
        phase: "EAST_WEST",
        step: "GREEN",
        signals: { NORTH: "RED", SOUTH: "RED", EAST: "GREEN", WEST: "GREEN" },
        confirmedAt: 0,
      },
    };
    state = addVehicle(state, "NORTH", "lone-employee", "EMPLOYEE_VEHICLE", 0);
    for (let second = 1; second <= 90; second += 1) {
      state = addVehicle(state, "EAST", `stream-truck-${second}`, "TRUCK", second * 1_000);
    }

    const result = schedulerTick(state, 90_000, "employee starvation at 90 seconds vs 90 trucks");
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("NORTH_SOUTH");
  });

  it("holds small score advantages through minimum green and anti-flap dwell", () => {
    let state: JunctionState = {
      ...createState(),
      config: {
        ...DEFAULT_JUNCTION_CONFIG,
        durations: { ...DEFAULT_JUNCTION_CONFIG.durations, GREEN: 1_000 },
        antiFlapMs: 5_000,
        maxGreenMs: 20_000,
      },
    };
    state = addVehicle(state, "NORTH", "north-car", "CAR", 0);
    state = addVehicle(state, "EAST", "east-motorcycle", "MOTORCYCLE", 0);

    expect(schedulerTick(state, 1_000, "small advantage at minimum-green boundary").state.desired.step).toBe("GREEN");
    expect(schedulerTick(state, 4_999, "small advantage before anti-flap dwell").state.desired.step).toBe("GREEN");
    expect(schedulerTick(state, 5_000, "small advantage after hold and dwell").state.desired.step).toBe("GREEN");
  });

  it("switches from an empty current phase to waiting traffic after minimum green", () => {
    const state: JunctionState = {
      ...createState(),
      config: { ...DEFAULT_JUNCTION_CONFIG, durations: { ...DEFAULT_JUNCTION_CONFIG.durations, GREEN: 8_000 } },
      queues: { NORTH: [], SOUTH: [], EAST: [{ vehicleId: "waiting-car", type: "CAR", arrivedAt: 0 }], WEST: [] },
      queueCounts: { NORTH: 0, SOUTH: 0, EAST: 1, WEST: 0 },
    };
    expect(schedulerTick(state, 7_999, "empty current phase before minimum green").state.desired.step).toBe("GREEN");
    const result = schedulerTick(state, 8_000, "empty current phase at minimum green");
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("EAST_WEST");
  });

  it("switches at maximum green when the opposite phase has traffic", () => {
    let state: JunctionState = {
      ...createState(),
      config: {
        ...DEFAULT_JUNCTION_CONFIG,
        durations: { ...DEFAULT_JUNCTION_CONFIG.durations, GREEN: 30_000 },
        maxGreenMs: 10_000,
      },
    };
    state = addVehicle(state, "EAST", "max-green-waiting-car", "CAR", 0);
    const result = schedulerTick(state, 10_000, "maximum green with competing queue");
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("EAST_WEST");
  });

  it("does not switch at max-green when neither phase has traffic", () => {
    const state: JunctionState = {
      ...createState(),
      config: { ...DEFAULT_JUNCTION_CONFIG, maxGreenMs: 10_000 },
    };
    const first = schedulerTick(state, 10_000, "no traffic at max green");
    const second = schedulerTick(first.state, 100_000, "still no traffic beyond max green");
    expect(second.state.desired.phase).toBe("NORTH_SOUTH");
    expect(second.state.desired.step).toBe("GREEN");
    expect(second.effects).toHaveLength(0);
  });

  it("starts the safe sequence immediately for a conflicting-side emergency", () => {
    const state = createState();
    const result = decide(state, {
      type: "VEHICLE_ARRIVED",
      direction: "EAST",
      vehicleId: "ambulance-east",
      vehicleType: "EMERGENCY",
    }, 100);

    expect(result.state.mode).toBe("EMERGENCY");
    expect(result.state.desired.phase).toBe("NORTH_SOUTH");
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("EAST_WEST");
    expect(result.state.desired.signals.EAST).not.toBe("GREEN");
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "SET_DESIRED_SIGNALS", phase: "NORTH_SOUTH", step: "YELLOW" }),
    ]);
  });

  it("keeps GREEN when an emergency is already on the active phase", () => {
    const result = decide(createState(), {
      type: "VEHICLE_ARRIVED",
      direction: "SOUTH",
      vehicleId: "ambulance-south",
      vehicleType: "EMERGENCY",
    }, 100);

    expect(result.state.mode).toBe("EMERGENCY");
    expect(result.state.desired.phase).toBe("NORTH_SOUTH");
    expect(result.state.desired.step).toBe("GREEN");
    expect(result.effects).toHaveLength(0);
  });

  it("deduplicates an emergency and refreshes only lastSeenAt", () => {
    const first = decide(createState(), {
      type: "EMERGENCY_REQUEST",
      emergencyId: "emergency-1",
      vehicleId: "vehicle-1",
      phase: "EAST_WEST",
      occurredAt: 100,
    }, 100).state;
    const originalRequest = first.emergencyRequests[0];
    expect(originalRequest).toBeDefined();

    const refreshed = decide(first, {
      type: "EMERGENCY_REQUEST",
      emergencyId: "emergency-1",
      vehicleId: "vehicle-1",
      phase: "NORTH_SOUTH",
      occurredAt: 200,
    }, 200);

    expect(refreshed.state.emergencyRequests).toHaveLength(1);
    expect(refreshed.state.emergencyRequests[0]).toEqual({ ...originalRequest, lastSeenAt: 200 });
    expect(refreshed.state.pendingPhase).toBe("EAST_WEST");
    expect(refreshed.effects).toHaveLength(0);
  });

  it("queues a conflicting second emergency without changing the active target", () => {
    let state = decide(createState(), {
      type: "EMERGENCY_REQUEST",
      emergencyId: "first-east",
      vehicleId: "first-east",
      phase: "EAST_WEST",
      occurredAt: 0,
    }, 0).state;
    const second = decide(state, {
      type: "EMERGENCY_REQUEST",
      emergencyId: "second-north",
      vehicleId: "second-north",
      phase: "NORTH_SOUTH",
      occurredAt: 1,
    }, 1);
    state = second.state;

    expect(state.emergencyRequests.map(({ emergencyId }) => emergencyId)).toEqual([
      "first-east",
      "second-north",
    ]);
    expect(state.pendingPhase).toBe("EAST_WEST");
    expect(state.desired.step).toBe("YELLOW");
    expect(second.effects).toHaveLength(0);
  });

  it("batches emergencies from the same phase without a phase flip", () => {
    let state = decide(createState(), {
      type: "VEHICLE_ARRIVED",
      direction: "NORTH",
      vehicleId: "ambulance-north-1",
      vehicleType: "EMERGENCY",
    }, 0).state;
    const result = decide(state, {
      type: "VEHICLE_ARRIVED",
      direction: "SOUTH",
      vehicleId: "ambulance-south-2",
      vehicleType: "EMERGENCY",
    }, 1);
    state = result.state;

    expect(state.emergencyRequests).toHaveLength(2);
    expect(state.emergencyRequests.every((emergency) => emergency.phase === "NORTH_SOUTH")).toBe(true);
    expect(state.desired.phase).toBe("NORTH_SOUTH");
    expect(state.desired.step).toBe("GREEN");
    expect(result.effects).toHaveLength(0);
  });

  it("lets an emergency override MANUAL then restores the still-live manual target when cleared", () => {
    let state = decide(createState(), { type: "MANUAL_MODE_REQUEST", phase: "EAST_WEST" }, 0).state;
    expect(state.mode).toBe("MANUAL");
    const emergency = decide(state, {
      type: "VEHICLE_ARRIVED",
      direction: "NORTH",
      vehicleId: "manual-emergency",
      vehicleType: "EMERGENCY",
    }, 1);
    state = emergency.state;
    expect(state.mode).toBe("EMERGENCY");
    expect(state.desired.step).toBe("YELLOW");
    expect(state.pendingPhase).toBe("NORTH_SOUTH");

    const cleared = decide(state, {
      type: "VEHICLE_CLEARED",
      direction: "NORTH",
      vehicleId: "manual-emergency",
    }, 2);
    state = cleared.state;
    expect(state.mode).toBe("MANUAL");
    expect(state.emergencyRequests).toHaveLength(0);
    expect(state.desired.step).toBe("YELLOW");
    expect(state.pendingPhase).toBe("EAST_WEST");
  });

  it("clears emergency mode on VEHICLE_CLEARED", () => {
    let state = decide(createState(), {
      type: "VEHICLE_ARRIVED",
      direction: "EAST",
      vehicleId: "ambulance-clear",
      vehicleType: "EMERGENCY",
    }, 0).state;
    const result = decide(state, {
      type: "VEHICLE_CLEARED",
      direction: "EAST",
      vehicleId: "ambulance-clear",
    }, 1);
    state = result.state;

    expect(state.emergencyRequests).toHaveLength(0);
    expect(state.mode).toBe("AUTOMATIC");
    expect(state.queueCounts.EAST).toBe(0);
  });

  it("expires an emergency after EMERGENCY_STALE_MS without a refresh", () => {
    const emergency = decide(createState(), {
      type: "EMERGENCY_REQUEST",
      emergencyId: "stale-emergency",
      phase: "EAST_WEST",
      occurredAt: 0,
    }, 0).state;
    const beforeExpiry = decide(emergency, { type: "TICK" }, DEFAULT_JUNCTION_CONFIG.emergencyStaleMs);
    expect(beforeExpiry.state.mode).toBe("EMERGENCY");
    const expired = decide(beforeExpiry.state, { type: "TICK" }, DEFAULT_JUNCTION_CONFIG.emergencyStaleMs + 1);

    expect(expired.state.mode).toBe("AUTOMATIC");
    expect(expired.state.emergencyRequests).toHaveLength(0);
  });

  it("routes every automatic phase switch through YELLOW then ALL_RED before GREEN", () => {
    let state: JunctionState = {
      ...createState(),
      config: {
        ...DEFAULT_JUNCTION_CONFIG,
        durations: { ...DEFAULT_JUNCTION_CONFIG.durations, GREEN: 1_000, YELLOW: 5_000, ALL_RED: 2_000 },
        antiFlapMs: 1_000,
      },
    };
    state = addVehicle(state, "EAST", "safe-sequence-car", "CAR", 0);
    const order = [state.desired.step];
    const yellow = schedulerTick(state, 1_000, "safe sequence starts");
    state = yellow.state;
    order.push(state.desired.step);
    expect(state.desired.step).toBe("YELLOW");

    state = confirmDesired(state, 1_000);
    state = schedulerTick(state, 6_000, "YELLOW dwell completed").state;
    order.push(state.desired.step);
    expect(state.desired.step).toBe("ALL_RED");

    state = confirmDesired(state, 6_000);
    state = schedulerTick(state, 8_000, "ALL_RED dwell completed").state;
    order.push(state.desired.step);
    expect(order).toEqual(["GREEN", "YELLOW", "ALL_RED", "GREEN"]);
    expect(state.desired.phase).toBe("EAST_WEST");
    assertSafe(state);
  });

  it("uses the exact GREEN -> YELLOW(5s) -> ALL_RED -> target GREEN sequence", () => {
    let now = 0;
    const clock = {
      now: () => now,
      advance: (milliseconds: number) => { now += milliseconds; },
    };
    let state: JunctionState = {
      ...createState(),
      config: {
        ...DEFAULT_JUNCTION_CONFIG,
        durations: { ...DEFAULT_JUNCTION_CONFIG.durations, YELLOW: 5_000, ALL_RED: 1_000 },
      },
    };
    const order: Array<{ phase: Phase; step: string; at: number }> = [
      { phase: state.desired.phase, step: state.desired.step, at: clock.now() },
    ];

    const request = decide(state, { type: "TARGET_PHASE_REQUEST", phase: "EAST_WEST" }, clock.now());
    state = request.state;
    order.push({ phase: state.desired.phase, step: state.desired.step, at: clock.now() });
    expect(state.desired.step).toBe("YELLOW");

    state = confirmDesired(state, clock.now());
    clock.advance(4_999);
    const beforeYellowDwell = decide(state, { type: "TICK" }, clock.now());
    state = beforeYellowDwell.state;
    expect(state.desired.step).toBe("YELLOW");

    clock.advance(1);
    const allRed = decide(state, { type: "TICK" }, clock.now());
    state = allRed.state;
    order.push({ phase: state.desired.phase, step: state.desired.step, at: clock.now() });
    expect(state.desired.step).toBe("ALL_RED");

    state = confirmDesired(state, clock.now());
    clock.advance(999);
    state = decide(state, { type: "TICK" }, clock.now()).state;
    expect(state.desired.step).toBe("ALL_RED");

    clock.advance(1);
    const targetGreen = decide(state, { type: "TICK" }, clock.now());
    state = targetGreen.state;
    order.push({ phase: state.desired.phase, step: state.desired.step, at: clock.now() });

    expect(order).toEqual([
      { phase: "NORTH_SOUTH", step: "GREEN", at: 0 },
      { phase: "NORTH_SOUTH", step: "YELLOW", at: 0 },
      { phase: "NORTH_SOUTH", step: "ALL_RED", at: 5_000 },
      { phase: "EAST_WEST", step: "GREEN", at: 6_000 },
    ]);
    expect(state.desired.phase).toBe("EAST_WEST");
    expect(state.desired.step).toBe("GREEN");
  });

  it("rejects unknown commands and malformed directions/phases without changing state", () => {
    const cases: unknown[] = [
      { type: "UNKNOWN_COMMAND", phase: "EAST_WEST" },
      { type: "VEHICLE_ARRIVED", direction: "UP", vehicleId: "invalid", vehicleType: "CAR" },
      { type: "VEHICLE_CLEARED", direction: "DOWN", vehicleId: "missing" },
      { type: "TARGET_PHASE_REQUEST", phase: "DIAGONAL" },
      { type: "MANUAL_MODE_REQUEST", phase: "DIAGONAL" },
      { type: "EMERGENCY_REQUEST", emergencyId: "bad", phase: "DIAGONAL", occurredAt: 0 },
      { type: "ACK", commandId: "not-an-engine-input" },
      { type: "TIMEOUT", commandId: "not-an-engine-input" },
    ];

    for (const input of cases) {
      const state = createState();
      const result = decide(state, input as TrafficInput, 500);
      expect(result.state, JSON.stringify(input)).toBe(state);
      expect(result.effects, JSON.stringify(input)).toEqual([]);
      expect(() => assertSafe(result.state)).not.toThrow();
    }
  });

  it("falls back to ALL_RED and emits an audit effect for unsafe input state", () => {
    const state = createState();
    state.desired.signals.EAST = "GREEN";
    state.actual.signals.EAST = "GREEN";

    const result = decide(state, { type: "TICK" }, 1234);

    expect(result.state.mode).toBe("DEGRADED");
    expect(result.state.desired.step).toBe("ALL_RED");
    expect(Object.values(result.state.desired.signals).every((signal) => signal === "RED")).toBe(true);
    expect(result.state.actual.step).toBe("UNKNOWN");
    expect(Object.values(result.state.actual.signals).every((signal) => signal === "UNKNOWN")).toBe(true);
    expect(result.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "SET_DESIRED_SIGNALS", step: "ALL_RED" }),
      expect.objectContaining({ type: "AUDIT_UNSAFE_STATE" }),
    ]));
    expect(() => assertSafe(result.state)).not.toThrow();
  });

  it("runs with Junction B configuration values rather than Junction A constants", () => {
    const state: JunctionState = {
      ...createState(),
      junctionId: "B",
      config: {
        ...DEFAULT_JUNCTION_CONFIG,
        durations: { ...DEFAULT_JUNCTION_CONFIG.durations, YELLOW: 8_000, ALL_RED: 2_500 },
      },
    };
    const change = decide(state, { type: "TARGET_PHASE_REQUEST", phase: "EAST_WEST" }, 0);
    const yellowAcked: JunctionState = {
      ...change.state,
      actual: { ...change.state.desired, confirmedAt: 0 },
    };

    expect(yellowAcked.junctionId).toBe("B");
    expect(decide(yellowAcked, { type: "TICK" }, 7_999).state.desired.step).toBe("YELLOW");
    const allRed = decide(yellowAcked, { type: "TICK" }, 8_000).state;
    expect(allRed.desired.step).toBe("ALL_RED");
    const allRedAcked = {
      ...allRed,
      actual: { ...allRed.desired, confirmedAt: 8_000 },
    };
    expect(decide(allRedAcked, { type: "TICK" }, 10_499).state.desired.step).toBe("ALL_RED");
    const green = decide(allRedAcked, { type: "TICK" }, 10_500).state;
    expect(green.desired.phase).toBe("EAST_WEST");
    expect(green.desired.step).toBe("GREEN");
  });

  it("keeps engine imports free of I/O and framework modules", async () => {
    const source = await readFile(new URL("./traffic.service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfrom\s+["'](?:express|pg|socket\.io|node:fs|fs)(?:["'/])/);
    expect(source).not.toMatch(/\bimport\s*\(\s*["'](?:express|pg|socket\.io|node:fs|fs)/);
  });

  it("preserves safety through 10,000 seeded random input sequences", () => {
    const initialSeed = 0x5eed1234;
    let seed = initialSeed;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const directions = ["NORTH", "SOUTH", "EAST", "WEST"] as const;
    const phases = ["NORTH_SOUTH", "EAST_WEST"] as const;
    const vehicleTypes = ["CAR", "MOTORCYCLE", "BUS", "TRUCK", "EMERGENCY", "EMPLOYEE_VEHICLE"] as const;
    let now = 0;

    for (let sequence = 0; sequence < 10_000; sequence += 1) {
      let state = createState();
      const sequenceLength = 1 + Math.floor(random() * 20);

      for (let step = 0; step < sequenceLength; step += 1) {
        now += Math.floor(random() * 10_000);
        const choice = Math.floor(random() * 12);
        let input: unknown;
        if (choice === 0) {
          input = { type: "VEHICLE_ARRIVED", direction: directions[Math.floor(random() * 4)], vehicleId: `v-${sequence}-${step}`, vehicleType: vehicleTypes[Math.floor(random() * vehicleTypes.length)] };
        } else if (choice === 1) {
          input = { type: "VEHICLE_CLEARED", direction: directions[Math.floor(random() * 4)], vehicleId: `v-${Math.floor(random() * 100)}-${Math.floor(random() * 20)}` };
        } else if (choice === 2) {
          input = { type: "EMERGENCY_REQUEST", emergencyId: `e-${sequence}-${step}`, phase: phases[Math.floor(random() * 2)], occurredAt: now };
        } else if (choice === 3) {
          input = { type: "MANUAL_MODE_REQUEST", phase: phases[Math.floor(random() * 2)] };
        } else if (choice === 4) {
          input = { type: "RETURN_TO_AUTOMATIC" };
        } else if (choice <= 7) {
          input = { type: "TICK" };
        } else if (choice === 8) {
          input = { type: "ACK", commandId: `ack-${sequence}-${step}` };
        } else if (choice === 9) {
          input = { type: "TIMEOUT", commandId: `timeout-${sequence}-${step}` };
        } else if (choice === 10) {
          input = { type: "VEHICLE_ARRIVED", direction: "INVALID", vehicleId: "bad", vehicleType: "CAR" };
        } else {
          input = { type: "TARGET_PHASE_REQUEST", phase: "INVALID" };
        }

        try {
          const result = decide(state, input as TrafficInput, now);
          state = result.state;
          if (result.effects.some((effect) => effect.type === "SET_DESIRED_SIGNALS")) {
            state = confirmDesired(state, now);
          }
          assertSafe(state);
          const northSouthGreen = state.desired.signals.NORTH === "GREEN" || state.desired.signals.SOUTH === "GREEN";
          const eastWestGreen = state.desired.signals.EAST === "GREEN" || state.desired.signals.WEST === "GREEN";
          expect(northSouthGreen && eastWestGreen).toBe(false);
        } catch (error) {
          throw new Error(`Invariant fuzz failed: seed=${initialSeed}, sequence=${sequence}, step=${step}, input=${JSON.stringify(input)}; ${String(error)}`);
        }
      }
    }
  });

  it("does not advance from ALL_RED while degraded", () => {
    const state = createState();
    const allRed = { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" } as const;
    state.mode = "DEGRADED";
    state.pendingPhase = "EAST_WEST";
    state.desired = { phase: "NORTH_SOUTH", step: "ALL_RED", signals: { ...allRed } };
    state.actual = {
      phase: "NORTH_SOUTH",
      step: "ALL_RED",
      signals: { ...allRed },
      confirmedAt: 0,
    };

    const result = decide(state, { type: "TICK" }, 10_000);
    expect(result.state.desired.step).toBe("ALL_RED");
    expect(result.effects).toHaveLength(0);
  });

  it("starts the same safe transition when an automatic green phase expires", () => {
    const queued = decide(
      createState(),
      {
        type: "VEHICLE_ARRIVED",
        direction: "EAST",
        vehicleId: "truck-1",
        vehicleType: "TRUCK",
      },
      100,
    ).state;
    const result = decide(queued, { type: "TICK" }, 30_100);

    expect(result.state.desired.phase).toBe("NORTH_SOUTH");
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("EAST_WEST");
    expect(result.effects).toHaveLength(1);
  });

  it.each<Mode>(["MANUAL", "EMERGENCY"])("does not auto-advance GREEN in %s mode", (mode) => {
    const result = decide(createState(mode), { type: "TICK" }, 30_000);

    expect(result.state.desired.step).toBe("GREEN");
    expect(result.effects).toHaveLength(0);
  });

  it("tracks arrivals once and ignores clears for vehicles not in the direction queue", () => {
    let state = createState();
    state = decide(
      state,
      { type: "VEHICLE_CLEARED", direction: "NORTH", vehicleId: "missing" },
      100,
    ).state;
    expect(state.queueCounts.NORTH).toBe(0);

    state = decide(
      state,
      {
        type: "VEHICLE_ARRIVED",
        direction: "NORTH",
        vehicleId: "employee-1",
        vehicleType: "EMPLOYEE_VEHICLE",
      },
      200,
    ).state;
    expect(state.queues.NORTH).toEqual([
      { vehicleId: "employee-1", type: "EMPLOYEE_VEHICLE", arrivedAt: 200 },
    ]);

    const duplicate = decide(
      state,
      {
        type: "VEHICLE_ARRIVED",
        direction: "EAST",
        vehicleId: "employee-1",
        vehicleType: "EMPLOYEE_VEHICLE",
      },
      300,
    );
    expect(duplicate.state).toBe(state);
    expect(duplicate.state.queueCounts.EAST).toBe(0);

    state = decide(
      state,
      { type: "VEHICLE_CLEARED", direction: "NORTH", vehicleId: "employee-1" },
      400,
    ).state;
    state = decide(
      state,
      { type: "VEHICLE_CLEARED", direction: "NORTH", vehicleId: "employee-1" },
      500,
    ).state;
    expect(state.queues.NORTH).toHaveLength(0);
    expect(state.queueCounts.NORTH).toBe(0);
    expect(Object.values(state.queueCounts).every((count) => count >= 0)).toBe(true);
  });

  it("compares weighted phase scores and observes anti-flap dwell", () => {
    let state = createState();
    state.config = { ...DEFAULT_JUNCTION_CONFIG, antiFlapMs: 40_000 };
    state = decide(
      state,
      {
        type: "VEHICLE_ARRIVED",
        direction: "EAST",
        vehicleId: "truck-1",
        vehicleType: "TRUCK",
      },
      1,
    ).state;

    let result = decide(state, { type: "TICK" }, 30_000);
    expect(result.state.desired.step).toBe("GREEN");

    result = decide(state, { type: "TICK" }, 40_000);
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("EAST_WEST");
  });

  it("keeps the higher-scoring active phase until maximum green forces service", () => {
    let state = createState();
    state.config = { ...DEFAULT_JUNCTION_CONFIG, maxGreenMs: 60_000 };
    for (let index = 0; index < 10; index += 1) {
      state = decide(
        state,
        {
          type: "VEHICLE_ARRIVED",
          direction: "NORTH",
          vehicleId: `north-truck-${index}`,
          vehicleType: "TRUCK",
        },
        index,
      ).state;
    }
    state = decide(
      state,
      {
        type: "VEHICLE_ARRIVED",
        direction: "EAST",
        vehicleId: "east-car",
        vehicleType: "CAR",
      },
      20,
    ).state;

    const beforeMax = decide(state, { type: "TICK" }, 30_000);
    expect(beforeMax.state.desired.step).toBe("GREEN");

    const atMax = decide(state, { type: "TICK" }, 60_000);
    expect(atMax.state.desired.step).toBe("YELLOW");
    expect(atMax.state.pendingPhase).toBe("EAST_WEST");
  });

  it("lets an old employee vehicle beat a continuing stream of trucks after starvation", () => {
    let state = createState();
    state.config = {
      ...DEFAULT_JUNCTION_CONFIG,
      durations: { ...DEFAULT_JUNCTION_CONFIG.durations, GREEN: 120_000 },
      maxGreenMs: 180_000,
    };
    const eastWestGreen: Record<Direction, SignalState> = {
      NORTH: "RED",
      SOUTH: "RED",
      EAST: "GREEN",
      WEST: "GREEN",
    };
    state = {
      ...state,
      desired: { phase: "EAST_WEST", step: "GREEN", signals: eastWestGreen },
      actual: {
        phase: "EAST_WEST",
        step: "GREEN",
        signals: { ...eastWestGreen },
        confirmedAt: 0,
      },
    };
    state = decide(
      state,
      {
        type: "VEHICLE_ARRIVED",
        direction: "NORTH",
        vehicleId: "old-employee",
        vehicleType: "EMPLOYEE_VEHICLE",
      },
      0,
    ).state;

    for (let index = 1; index <= 90; index += 1) {
      state = decide(
        state,
        {
          type: "VEHICLE_ARRIVED",
          direction: "EAST",
          vehicleId: `truck-${index}`,
          vehicleType: "TRUCK",
        },
        index * 1_000,
      ).state;
    }

    const result = decide(state, { type: "TICK" }, 90_000);
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("NORTH_SOUTH");
  });

  it("lets an emergency override manual mode without skipping the safe sequence", () => {
    let state = decide(
      createState(),
      { type: "MANUAL_MODE_REQUEST", phase: "EAST_WEST" },
      100,
    ).state;
    expect(state.mode).toBe("MANUAL");
    expect(state.desired.step).toBe("YELLOW");
    expect(state.pendingPhase).toBe("EAST_WEST");

    const result = decide(
      state,
      {
        type: "EMERGENCY_REQUEST",
        emergencyId: "ambulance-1",
        phase: "NORTH_SOUTH",
        occurredAt: 200,
      },
      200,
    );

    expect(result.state.mode).toBe("EMERGENCY");
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("NORTH_SOUTH");
    expect(result.effects).toHaveLength(0);
  });

  it("serves conflicting emergencies in earliest-request order", () => {
    let state = createState();
    state.config = { ...state.config, emergencyTtlMs: 100 };
    state = decide(
      state,
      { type: "EMERGENCY_REQUEST", emergencyId: "first", phase: "EAST_WEST", occurredAt: 0 },
      0,
    ).state;
    state = decide(
      state,
      { type: "EMERGENCY_REQUEST", emergencyId: "second", phase: "NORTH_SOUTH", occurredAt: 1 },
      1,
    ).state;

    expect(state.pendingPhase).toBe("EAST_WEST");
    expect(state.emergencyRequests.map(({ emergencyId }) => emergencyId)).toEqual([
      "first",
      "second",
    ]);

    const expiredFirst = decide(state, { type: "TICK" }, 100);
    expect(expiredFirst.state.mode).toBe("EMERGENCY");
    expect(expiredFirst.state.emergencyRequests.map(({ emergencyId }) => emergencyId)).toEqual([
      "second",
    ]);
    expect(expiredFirst.state.pendingPhase).toBe("NORTH_SOUTH");
  });

  it("ignores stale emergency requests", () => {
    const state = createState();
    const result = decide(
      state,
      {
        type: "EMERGENCY_REQUEST",
        emergencyId: "stale",
        phase: "EAST_WEST",
        occurredAt: 1,
      },
      DEFAULT_JUNCTION_CONFIG.emergencyStaleMs + 2,
    );

    expect(result.state).toBe(state);
    expect(result.state.mode).toBe("AUTOMATIC");
    expect(result.state.emergencyRequests).toHaveLength(0);
  });

  it("refreshes repeated emergency expiry without changing its order or phase", () => {
    let state = decide(
      createState(),
      { type: "EMERGENCY_REQUEST", emergencyId: "unit-1", phase: "EAST_WEST", occurredAt: 100 },
      100,
    ).state;
    const firstRequest = state.emergencyRequests[0];
    const result = decide(
      state,
      { type: "EMERGENCY_REQUEST", emergencyId: "unit-1", phase: "NORTH_SOUTH", occurredAt: 200 },
      200,
    );
    state = result.state;

    expect(result.effects).toHaveLength(0);
    expect(state.emergencyRequests).toHaveLength(1);
    expect(state.emergencyRequests[0]).toEqual({
      ...firstRequest,
      lastSeenAt: 200,
    });
    expect(state.pendingPhase).toBe("EAST_WEST");
  });

  it("expires manual mode after its TTL and resumes automatic mode safely", () => {
    let state = createState();
    state.config = { ...state.config, manualTtlMs: 100 };
    state = decide(state, { type: "MANUAL_MODE_REQUEST", phase: "EAST_WEST" }, 10).state;
    expect(state.mode).toBe("MANUAL");
    expect(state.pendingPhase).toBe("EAST_WEST");

    const result = decide(state, { type: "TICK" }, 110);
    expect(result.state.mode).toBe("AUTOMATIC");
    expect(result.state.manualOverride).toBeNull();
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("NORTH_SOUTH");
  });

  it("returns to automatic mode without bypassing an in-progress transition", () => {
    let state = decide(createState(), { type: "MANUAL_MODE_REQUEST", phase: "EAST_WEST" }, 10).state;
    const result = decide(state, { type: "RETURN_TO_AUTOMATIC" }, 20);

    expect(result.state.mode).toBe("AUTOMATIC");
    expect(result.state.manualOverride).toBeNull();
    expect(result.state.desired.step).toBe("YELLOW");
    expect(result.state.pendingPhase).toBe("NORTH_SOUTH");
    expect(result.effects).toHaveLength(0);
  });

  it.each<Mode>(["AUTOMATIC", "MANUAL", "EMERGENCY"])(
    "uses GREEN -> YELLOW -> ALL_RED -> GREEN in %s mode",
    (mode) => {
      let state = createState(mode);

      let result = decide(
        state,
        { type: "TARGET_PHASE_REQUEST", phase: "EAST_WEST" },
        100,
      );
      state = result.state;
      expect(state.desired.step).toBe("YELLOW");
      expect(state.actual.step).toBe("GREEN");
      expect(result.effects).toHaveLength(1);

      result = decide(state, { type: "TICK" }, 10_000);
      expect(result.state.desired.step).toBe("YELLOW");

      state = confirmDesired(state, 100);
      result = decide(state, { type: "TICK" }, 3_100);
      state = result.state;
      expect(state.desired.step).toBe("ALL_RED");
      expect(Object.values(state.desired.signals).every((signal) => signal === "RED")).toBe(true);

      result = decide(state, { type: "TICK" }, 20_000);
      expect(result.state.desired.step).toBe("ALL_RED");

      state = confirmDesired(state, 3_100);
      result = decide(state, { type: "TICK" }, 4_099);
      expect(result.state.desired.step).toBe("ALL_RED");

      result = decide(result.state, { type: "TICK" }, 4_100);
      expect(result.state.desired.phase).toBe("EAST_WEST");
      expect(result.state.desired.step).toBe("GREEN");
      expect(result.state.pendingPhase).toBeNull();
      expect(result.effects).toHaveLength(1);
      assertSafe(result.state);
    },
  );

  it("updates the pending target without skipping the safe sequence", () => {
    let state = decide(
      createState(),
      { type: "TARGET_PHASE_REQUEST", phase: "EAST_WEST" },
      100,
    ).state;

    const result = decide(
      state,
      { type: "TARGET_PHASE_REQUEST", phase: "NORTH_SOUTH" },
      200,
    );
    state = result.state;

    expect(state.desired.step).toBe("YELLOW");
    expect(state.pendingPhase).toBe("NORTH_SOUTH");
    expect(result.effects).toHaveLength(0);
  });

  it("does not allow assertSafe to accept conflicting green signals", () => {
    const state = createState();
    state.desired.signals.EAST = "GREEN";
    expect(() => assertSafe(state)).toThrow(/conflicting GREEN/);
  });

  it("preserves the no-conflicting-GREEN invariant over randomized inputs", () => {
    let seed = 19_871;
    const random = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed / 2_147_483_647;
    };

    let state = createState();
    let now = 0;

    for (let index = 0; index < 20_000; index += 1) {
      now += Math.floor(random() * 5_000);

      const input: TrafficInput = random() < 0.65
        ? { type: "TICK" }
        : {
            type: "TARGET_PHASE_REQUEST",
            phase: random() < 0.5 ? "NORTH_SOUTH" : "EAST_WEST",
          };
      const result = decide(state, input, now);
      state = result.state;

      if (result.effects.length > 0) {
        state = confirmDesired(state, now);
      }

      expect(() => assertSafe(state)).not.toThrow();
      const northSouthGreen =
        state.desired.signals.NORTH === "GREEN" || state.desired.signals.SOUTH === "GREEN";
      const eastWestGreen =
        state.desired.signals.EAST === "GREEN" || state.desired.signals.WEST === "GREEN";
      expect(northSouthGreen && eastWestGreen).toBe(false);
    }
  });
});
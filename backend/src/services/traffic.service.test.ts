import { describe, expect, it } from "vitest";
import {
  assertSafe,
  DEFAULT_JUNCTION_CONFIG,
  decide,
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

describe("decide", () => {
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
      expiresAt: 200 + state.config.emergencyTtlMs,
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
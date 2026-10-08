export type Direction = "NORTH" | "SOUTH" | "EAST" | "WEST";

export type Phase = "NORTH_SOUTH" | "EAST_WEST";

export type SignalState = "RED" | "YELLOW" | "GREEN" | "UNKNOWN";

export type Mode = "AUTOMATIC" | "MANUAL" | "EMERGENCY" | "DEGRADED";

export type PhaseStep = "GREEN" | "YELLOW" | "ALL_RED";

export type VehicleType =
  | "CAR"
  | "MOTORCYCLE"
  | "BUS"
  | "TRUCK"
  | "FORKLIFT"
  | "EMERGENCY"
  | "EMPLOYEE_VEHICLE";

export interface QueuedVehicle {
  vehicleId: string;
  type: VehicleType;
  arrivedAt: number;
}

export interface JunctionConfig {
  phases: readonly Phase[];
  durations: Readonly<Record<PhaseStep, number>>;
  vehiclePriorityWeights: Readonly<Record<VehicleType, number>>;
  antiFlapMs: number;
  starvationMs: number;
  maxGreenMs: number;
  scoreSwitchMargin: number;
  emergencyTtlMs: number;
  emergencyStaleMs: number;
  manualTtlMs: number;
}

export interface EmergencyRequest {
  emergencyId: string;
  vehicleId: string;
  phase: Phase;
  receivedAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface ManualOverride {
  phase: Phase;
  expiresAt: number;
}

export interface JunctionState {
  junctionId: string;
  mode: Mode;
  config: JunctionConfig;
  pendingPhase: Phase | null;
  emergencyRequests: EmergencyRequest[];
  manualOverride: ManualOverride | null;
  desired: {
    phase: Phase;
    step: PhaseStep;
    signals: Record<Direction, SignalState>;
  };
  actual: {
    phase: Phase;
    step: PhaseStep | "UNKNOWN";
    signals: Record<Direction, SignalState>;
    confirmedAt: number;
  };
  queues: Record<Direction, QueuedVehicle[]>;
  queueCounts: Record<Direction, number>;
}

export type TrafficInput =
  | { type: "TICK" }
  | { type: "TARGET_PHASE_REQUEST"; phase: Phase }
  | { type: "EMERGENCY_REQUEST"; emergencyId: string; phase: Phase; occurredAt: number; vehicleId?: string }
  | { type: "MANUAL_MODE_REQUEST"; phase: Phase; direction?: Direction }
  | { type: "RETURN_TO_AUTOMATIC" }
  | {
      type: "VEHICLE_ARRIVED";
      direction: Direction;
      vehicleId: string;
      vehicleType: VehicleType;
    }
  | { type: "VEHICLE_CLEARED"; direction: Direction; vehicleId: string };

export interface SetDesiredSignalsEffect {
  type: "SET_DESIRED_SIGNALS";
  phase: Phase;
  step: PhaseStep;
  signals: Record<Direction, SignalState>;
}

export interface UnsafeStateAuditEffect {
  type: "AUDIT_UNSAFE_STATE";
  reason: string;
}

export type TrafficEffect = SetDesiredSignalsEffect | UnsafeStateAuditEffect;

export interface PhaseScoreContribution {
  direction: Direction;
  vehicleId: string;
  vehicleType: VehicleType;
  weight: number;
}

export interface PhaseScoreBreakdown {
  phase: Phase;
  score: number;
  contributions: PhaseScoreContribution[];
}

const validDirections = new Set<Direction>(["NORTH", "SOUTH", "EAST", "WEST"]);
const validPhases = new Set<Phase>(["NORTH_SOUTH", "EAST_WEST"]);
const validVehicleTypes = new Set<VehicleType>([
  "CAR",
  "MOTORCYCLE",
  "BUS",
  "TRUCK",
  "FORKLIFT",
  "EMERGENCY",
  "EMPLOYEE_VEHICLE",
]);

function isValidTrafficInput(input: unknown): input is TrafficInput {
  if (typeof input !== "object" || input === null || !("type" in input)) return false;
  const candidate = input as Record<string, unknown>;

  switch (candidate.type) {
    case "TICK":
    case "RETURN_TO_AUTOMATIC":
      return true;
    case "TARGET_PHASE_REQUEST":
    case "MANUAL_MODE_REQUEST":
      return typeof candidate.phase === "string" && validPhases.has(candidate.phase as Phase) &&
        (candidate.direction === undefined ||
          (typeof candidate.direction === "string" && validDirections.has(candidate.direction as Direction)));
    case "EMERGENCY_REQUEST":
      return typeof candidate.emergencyId === "string" && candidate.emergencyId.length > 0 &&
        typeof candidate.phase === "string" && validPhases.has(candidate.phase as Phase) &&
        typeof candidate.occurredAt === "number" && Number.isFinite(candidate.occurredAt) &&
        (candidate.vehicleId === undefined || (typeof candidate.vehicleId === "string" && candidate.vehicleId.length > 0));
    case "VEHICLE_ARRIVED":
      return typeof candidate.direction === "string" && validDirections.has(candidate.direction as Direction) &&
        typeof candidate.vehicleId === "string" && candidate.vehicleId.length > 0 &&
        typeof candidate.vehicleType === "string" && validVehicleTypes.has(candidate.vehicleType as VehicleType);
    case "VEHICLE_CLEARED":
      return typeof candidate.direction === "string" && validDirections.has(candidate.direction as Direction) &&
        typeof candidate.vehicleId === "string" && candidate.vehicleId.length > 0;
    default:
      return false;
  }
}

function hasConflictingGreens(state: JunctionState): boolean {
  return [state.desired.signals, state.actual.signals].some((signals) => {
    const northSouthGreen = signals.NORTH === "GREEN" || signals.SOUTH === "GREEN";
    const eastWestGreen = signals.EAST === "GREEN" || signals.WEST === "GREEN";
    return northSouthGreen && eastWestGreen;
  });
}

function recoverUnsafeState(
  state: JunctionState,
  now: number,
): { state: JunctionState; effects: TrafficEffect[] } {
  const phase = validPhases.has(state.desired.phase) ? state.desired.phase : "NORTH_SOUTH";
  const redSignals = { ...ALL_RED_SIGNALS };
  const unknownSignals: Record<Direction, SignalState> = {
    NORTH: "UNKNOWN",
    SOUTH: "UNKNOWN",
    EAST: "UNKNOWN",
    WEST: "UNKNOWN",
  };
  const nextState: JunctionState = {
    ...state,
    mode: "DEGRADED",
    pendingPhase: null,
    desired: { phase, step: "ALL_RED", signals: redSignals },
    actual: { phase, step: "UNKNOWN", signals: unknownSignals, confirmedAt: now },
  };

  return {
    state: nextState,
    effects: [
      { type: "SET_DESIRED_SIGNALS", phase, step: "ALL_RED", signals: redSignals },
      { type: "AUDIT_UNSAFE_STATE", reason: "Conflicting GREEN signals found in engine input state" },
    ],
  };
}

export const DEFAULT_JUNCTION_CONFIG: JunctionConfig = {
  phases: ["NORTH_SOUTH", "EAST_WEST"],
  durations: {
    GREEN: typeof process !== "undefined" && process.env.GREEN_DURATION_MS
      ? Number(process.env.GREEN_DURATION_MS)
      : 30_000,
    YELLOW: typeof process !== "undefined" && process.env.YELLOW_DURATION_MS
      ? Number(process.env.YELLOW_DURATION_MS)
      : 3_000,
    ALL_RED: typeof process !== "undefined" && process.env.ALL_RED_DURATION_MS
      ? Number(process.env.ALL_RED_DURATION_MS)
      : 1_000,
  },
  vehiclePriorityWeights: {
    CAR: 1,
    MOTORCYCLE: 1.2,
    BUS: 2,
    TRUCK: 1.5,
    FORKLIFT: 2.5,
    EMERGENCY: 10,
    EMPLOYEE_VEHICLE: 1.25,
  },
  antiFlapMs: 5_000,
  starvationMs: 90_000,
  maxGreenMs: 60_000,
  scoreSwitchMargin: 0.5,
  emergencyTtlMs: 120_000,
  emergencyStaleMs: 30_000,
  manualTtlMs: typeof process !== "undefined" && process.env.MANUAL_TTL_MS
    ? Number(process.env.MANUAL_TTL_MS)
    : 300_000,
};

const ALL_RED_SIGNALS: Record<Direction, SignalState> = {
  NORTH: "RED",
  SOUTH: "RED",
  EAST: "RED",
  WEST: "RED",
};

function signalsFor(phase: Phase, step: PhaseStep): Record<Direction, SignalState> {
  const signals = { ...ALL_RED_SIGNALS };
  const activeState: SignalState = step === "GREEN" ? "GREEN" : "YELLOW";

  if (step !== "ALL_RED") {
    if (phase === "NORTH_SOUTH") {
      signals.NORTH = activeState;
      signals.SOUTH = activeState;
    } else {
      signals.EAST = activeState;
      signals.WEST = activeState;
    }
  }

  return signals;
}

function createTransition(
  state: JunctionState,
  phase: Phase,
  step: PhaseStep,
  pendingPhase: Phase | null,
): { state: JunctionState; effects: TrafficEffect[] } {
  const signals = signalsFor(phase, step);
  const nextState: JunctionState = {
    ...state,
    pendingPhase,
    desired: { phase, step, signals },
  };

  assertSafe(nextState);

  return {
    state: nextState,
    effects: [{ type: "SET_DESIRED_SIGNALS", phase, step, signals }],
  };
}

function requestPhase(
  state: JunctionState,
  phase: Phase,
): { state: JunctionState; effects: TrafficEffect[] } {
  if (state.desired.step === "GREEN") {
    if (phase === state.desired.phase) return { state, effects: [] };
    return createTransition(state, state.desired.phase, "YELLOW", phase);
  }

  if (state.pendingPhase === phase) return { state, effects: [] };
  return { state: { ...state, pendingPhase: phase }, effects: [] };
}

function effectiveMode(state: JunctionState): Mode {
  if (state.emergencyRequests.length > 0) return "EMERGENCY";
  if (state.manualOverride !== null) return "MANUAL";
  return "AUTOMATIC";
}

function activeRequestedPhase(state: JunctionState): Phase | null {
  return state.emergencyRequests[0]?.phase ?? state.manualOverride?.phase ?? null;
}

function directionsForPhase(phase: Phase): readonly Direction[] {
  return phase === "NORTH_SOUTH" ? ["NORTH", "SOUTH"] : ["EAST", "WEST"];
}

function scorePhase(state: JunctionState, phase: Phase): number {
  return directionsForPhase(phase).reduce(
    (score, direction) =>
      score + state.queues[direction].reduce(
        (directionScore, vehicle) =>
          directionScore + state.config.vehiclePriorityWeights[vehicle.type],
        0,
      ),
    0,
  );
}

export function getPhaseScoreBreakdown(state: JunctionState): PhaseScoreBreakdown[] {
  return state.config.phases.map((phase) => {
    const contributions = directionsForPhase(phase).flatMap((direction) =>
      state.queues[direction].map((vehicle) => ({
        direction,
        vehicleId: vehicle.vehicleId,
        vehicleType: vehicle.type,
        weight: state.config.vehiclePriorityWeights[vehicle.type],
      })),
    );
    return {
      phase,
      score: contributions.reduce((total, contribution) => total + contribution.weight, 0),
      contributions,
    };
  });
}

function oldestWaitForPhase(state: JunctionState, phase: Phase, now: number): number {
  return directionsForPhase(phase).reduce(
    (oldestWait, direction) =>
      state.queues[direction].reduce(
        (directionOldestWait, vehicle) =>
          Math.max(directionOldestWait, now - vehicle.arrivedAt),
        oldestWait,
      ),
    0,
  );
}

function selectScheduledPhase(state: JunctionState, now: number): Phase | null {
  const phases = state.config.phases;
  if (phases.length < 2) return null;

  const starvedPhase = phases
    .filter((phase) => phase !== state.desired.phase)
    .map((phase) => ({ phase, wait: oldestWaitForPhase(state, phase, now) }))
    .filter(({ wait }) => wait >= state.config.starvationMs)
    .sort((left, right) => right.wait - left.wait)[0];

  if (starvedPhase) return starvedPhase.phase;

  return phases
    .slice()
    .sort((left, right) => {
      const scoreDifference = scorePhase(state, right) - scorePhase(state, left);
      if (scoreDifference !== 0) return scoreDifference;
      if (left === state.desired.phase) return -1;
      if (right === state.desired.phase) return 1;
      return 0;
    })[0] ?? null;
}

function selectAlternativePhase(state: JunctionState): Phase | null {
  return state.config.phases
    .filter((phase) => phase !== state.desired.phase)
    .sort((left, right) => scorePhase(state, right) - scorePhase(state, left))[0] ?? null;
}

function containsVehicle(state: JunctionState, vehicleId: string): boolean {
  return Object.values(state.queues).some((queue) =>
    queue.some((vehicle) => vehicle.vehicleId === vehicleId),
  );
}

function updateVehicleQueue(
  state: JunctionState,
  input: Extract<TrafficInput, { type: "VEHICLE_ARRIVED" | "VEHICLE_CLEARED" }>,
  now: number,
): JunctionState {
  const queue = state.queues[input.direction];

  if (input.type === "VEHICLE_ARRIVED") {
    if (containsVehicle(state, input.vehicleId)) return state;

    const nextQueue = [
      ...queue,
      { vehicleId: input.vehicleId, type: input.vehicleType, arrivedAt: now },
    ];
    return {
      ...state,
      queues: { ...state.queues, [input.direction]: nextQueue },
      queueCounts: {
        ...state.queueCounts,
        [input.direction]: state.queueCounts[input.direction] + 1,
      },
    };
  }

  const vehicleIndex = queue.findIndex((vehicle) => vehicle.vehicleId === input.vehicleId);
  if (vehicleIndex < 0) return state;

  const nextQueue = queue.filter((vehicle) => vehicle.vehicleId !== input.vehicleId);
  return {
    ...state,
    queues: { ...state.queues, [input.direction]: nextQueue },
    queueCounts: {
      ...state.queueCounts,
      [input.direction]: Math.max(0, state.queueCounts[input.direction] - 1),
    },
  };
}

function refreshOrAddEmergency(
  state: JunctionState,
  emergencyId: string,
  vehicleId: string,
  phase: Phase,
  now: number,
): { state: JunctionState; added: boolean } {
  const existing = state.emergencyRequests.find(
    (request) => request.emergencyId === emergencyId || request.vehicleId === vehicleId,
  );
  if (existing !== undefined) {
    return {
      state: {
        ...state,
        mode: "EMERGENCY",
        emergencyRequests: state.emergencyRequests.map((request) =>
          request === existing ? { ...request, lastSeenAt: now } : request,
        ),
      },
      added: false,
    };
  }

  const emergencyRequests = [...state.emergencyRequests, {
    emergencyId,
    vehicleId,
    phase,
    receivedAt: now,
    lastSeenAt: now,
    expiresAt: now + state.config.emergencyTtlMs,
  }].sort((left, right) => left.receivedAt - right.receivedAt);
  return { state: { ...state, emergencyRequests, mode: "EMERGENCY" }, added: true };
}

export function assertSafe(state: JunctionState): void {
  for (const [label, signals] of [
    ["desired", state.desired.signals],
    ["actual", state.actual.signals],
  ] as const) {
    const hasNorthSouthGreen =
      signals.NORTH === "GREEN" || signals.SOUTH === "GREEN";
    const hasEastWestGreen = signals.EAST === "GREEN" || signals.WEST === "GREEN";

    if (hasNorthSouthGreen && hasEastWestGreen) {
      throw new Error(`${label} signals contain conflicting GREEN phases`);
    }
  }
}

export function decide(
  state: JunctionState,
  input: TrafficInput,
  now: number,
): { state: JunctionState; effects: TrafficEffect[] } {
  if (hasConflictingGreens(state)) return recoverUnsafeState(state, now);
  if (!isValidTrafficInput(input)) return { state, effects: [] };

  if (state.mode === "DEGRADED" && input.type === "TICK") {
    return { state, effects: [] };
  }

  if (input.type === "TARGET_PHASE_REQUEST") {
    return requestPhase(state, input.phase);
  }

  if (input.type === "EMERGENCY_REQUEST") {
    if (now - input.occurredAt > state.config.emergencyStaleMs) {
      return { state, effects: [] };
    }

    const refreshed = refreshOrAddEmergency(
      state,
      input.emergencyId,
      input.vehicleId ?? input.emergencyId,
      input.phase,
      now,
    );
    const activePhase = activeRequestedPhase(refreshed.state);
    if (!refreshed.added || activePhase === null) return { state: refreshed.state, effects: [] };
    return requestPhase(refreshed.state, activePhase);
  }

  if (input.type === "MANUAL_MODE_REQUEST") {
    const nextState: JunctionState = {
      ...state,
      manualOverride: { phase: input.phase, expiresAt: now + state.config.manualTtlMs },
      mode: state.emergencyRequests.length > 0 ? "EMERGENCY" : "MANUAL",
    };
    if (nextState.emergencyRequests.length > 0) {
      return { state: nextState, effects: [] };
    }
    return requestPhase(nextState, input.phase);
  }

  if (input.type === "RETURN_TO_AUTOMATIC") {
    const nextState: JunctionState = {
      ...state,
      manualOverride: null,
      mode: state.emergencyRequests.length > 0 ? "EMERGENCY" : "AUTOMATIC",
    };
    const recoveryPhase = activeRequestedPhase(nextState) ??
      (nextState.desired.step === "GREEN" ? null : nextState.desired.phase);
    return recoveryPhase === null
      ? { state: nextState, effects: [] }
      : requestPhase(nextState, recoveryPhase);
  }

  if (input.type === "VEHICLE_ARRIVED" || input.type === "VEHICLE_CLEARED") {
    const queueState = updateVehicleQueue(state, input, now);
    if (input.type === "VEHICLE_ARRIVED") {
      if (input.vehicleType !== "EMERGENCY") return { state: queueState, effects: [] };
      const refreshed = refreshOrAddEmergency(
        queueState,
        input.vehicleId,
        input.vehicleId,
        phaseForDirection(input.direction),
        now,
      );
      const activePhase = activeRequestedPhase(refreshed.state);
      return activePhase === null
        ? { state: refreshed.state, effects: [] }
        : requestPhase(refreshed.state, activePhase);
    }

    const remainingEmergencies = queueState.emergencyRequests.filter(
      (request) => request.vehicleId !== input.vehicleId && request.emergencyId !== input.vehicleId,
    );
    if (remainingEmergencies.length === queueState.emergencyRequests.length) {
      return { state: queueState, effects: [] };
    }
    const afterEmergencyClear: JunctionState = {
      ...queueState,
      emergencyRequests: remainingEmergencies,
      mode: effectiveMode({ ...queueState, emergencyRequests: remainingEmergencies }),
    };
    const nextRequestedPhase = activeRequestedPhase(afterEmergencyClear);
    if (nextRequestedPhase !== null) return requestPhase(afterEmergencyClear, nextRequestedPhase);
    if (afterEmergencyClear.desired.step === "GREEN") {
      return { state: { ...afterEmergencyClear, pendingPhase: null }, effects: [] };
    }
    return {
      state: { ...afterEmergencyClear, pendingPhase: afterEmergencyClear.desired.phase },
      effects: [],
    };
  }

  const previousRequestedPhase = activeRequestedPhase(state);
  const emergencyRequests = state.emergencyRequests.filter((request) =>
    request.expiresAt > now && now - request.lastSeenAt <= state.config.emergencyStaleMs,
  );
  const manualOverride = state.manualOverride !== null && state.manualOverride.expiresAt > now
    ? state.manualOverride
    : null;
  state = {
    ...state,
    emergencyRequests,
    manualOverride,
    mode: effectiveMode({ ...state, emergencyRequests, manualOverride }),
  };

  const requestedPhase = activeRequestedPhase(state);
  if (requestedPhase !== previousRequestedPhase) {
    const fallbackPhase = requestedPhase ??
      (state.desired.step === "GREEN" ? null : state.desired.phase);
    if (fallbackPhase !== null) {
      const result = requestPhase(state, fallbackPhase);
      if (result.effects.length > 0 || result.state.pendingPhase !== state.pendingPhase) {
        return result;
      }
      state = result.state;
    }
  }

  if (state.desired.step === "GREEN" && state.mode === "AUTOMATIC") {
    const greenConfirmed =
      state.actual.phase === state.desired.phase && state.actual.step === "GREEN";
    const greenAge = now - state.actual.confirmedAt;
    const greenElapsed = greenAge >= state.config.durations.GREEN;
    const maxGreenReached = greenAge >= state.config.maxGreenMs;
    const selectedPhase = selectScheduledPhase(state, now);
    const targetPhase = selectedPhase === state.desired.phase && maxGreenReached
      ? selectAlternativePhase(state)
      : selectedPhase;
    const currentScore = scorePhase(state, state.desired.phase);
    const targetScore = targetPhase === null ? 0 : scorePhase(state, targetPhase);
    const selectedPhaseIsStarved = targetPhase !== null &&
      oldestWaitForPhase(state, targetPhase, now) >= state.config.starvationMs;
    const antiFlapElapsed = greenAge >= state.config.antiFlapMs;
    const scoreAdvantageReached = targetScore - currentScore >= state.config.scoreSwitchMargin;
    const otherPhaseHasTraffic = targetScore > 0;

    if (
      greenConfirmed &&
      targetPhase !== null &&
      targetPhase !== state.desired.phase &&
      otherPhaseHasTraffic &&
      (
        selectedPhaseIsStarved ||
        maxGreenReached ||
        (greenElapsed && antiFlapElapsed && scoreAdvantageReached)
      )
    ) {
      return createTransition(state, state.desired.phase, "YELLOW", targetPhase);
    }
  }

  if (state.desired.step === "YELLOW") {
    const yellowConfirmed =
      state.actual.phase === state.desired.phase && state.actual.step === "YELLOW";
    const yellowElapsed = now - state.actual.confirmedAt >= state.config.durations.YELLOW;

    if (yellowConfirmed && yellowElapsed) {
      return createTransition(state, state.desired.phase, "ALL_RED", state.pendingPhase);
    }
  }

  if (state.desired.step === "ALL_RED") {
    const allRedConfirmed =
      state.actual.step === "ALL_RED" &&
      Object.values(state.actual.signals).every((signal) => signal === "RED");
    const allRedElapsed = now - state.actual.confirmedAt >= state.config.durations.ALL_RED;

    if (allRedConfirmed && allRedElapsed && state.pendingPhase !== null) {
      return createTransition(state, state.pendingPhase, "GREEN", null);
    }
  }

  return { state, effects: [] };
}

function phaseForDirection(direction: Direction): Phase {
  return direction === "NORTH" || direction === "SOUTH" ? "NORTH_SOUTH" : "EAST_WEST";
}

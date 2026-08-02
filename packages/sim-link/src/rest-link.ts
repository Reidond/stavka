import {
  type Command,
  ConnectResponse,
  PROTOCOL_VERSION,
  TickResponse,
  type CommandResult,
  type CommanderConfigUpdates,
  type ConnectRequest,
  type DisconnectRequest,
  type DoctrineId,
  type MapUploadRequest,
  type SergeantReport,
  type TickRequest,
} from "@stavka/protocol";
import { drainEvents, executeCommand, type SimWorldState } from "@stavka/sim-core";
import { Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect";

import { EventFilter, filterVisibleEvents } from "./events";
import {
  REST_COMMANDER_LINK_STATE_VERSION,
  RestCommanderLinkState,
  type RestCommanderLinkCommandLifecycle,
} from "./link-state";
import { SergeantReporter } from "./sergeants";
import { decayKnownEnemies, diffSnapshots, projectWorld } from "./state";
import { RestTransport, Transport, type TransportService } from "./transport";

export interface RestCommanderLinkOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly sessionId: string;
  readonly faction: string;
  readonly missionId?: string;
  readonly missionName?: string;
  readonly missionEpoch?: number;
  readonly mapName?: string;
  readonly doctrine?: DoctrineId;
  readonly fullSnapshotInterval?: number;
  readonly detectionRangeMeters?: number;
  readonly contactExpirySeconds?: number;
  readonly deltaMovementThresholdMeters?: number;
  /** Per-attempt REST deadline. Defaults to 8 seconds and is capped at 60 seconds. */
  readonly requestTimeoutMs?: number;
  /** Initial delay for finite exponential retries. Defaults to 100 milliseconds. */
  readonly retryBaseDelayMs?: number;
  /** Retries after the first attempt. Defaults to two and is capped at five. */
  readonly retryMaxAttempts?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly transport?: TransportService;
  readonly now?: () => number;
}

export interface TickOutcome {
  readonly request: TickRequest;
  readonly response: TickResponse;
  readonly commandResults: readonly CommandResult[];
}

export class TickInFlightError extends Error {
  override readonly name = "TickInFlightError";
}

export class ConnectRejectedError extends Error {
  override readonly name = "ConnectRejectedError";
}

export class RestCommanderLinkStateMismatchError extends Error {
  override readonly name = "RestCommanderLinkStateMismatchError";
}

export class TickResponseMismatchError extends Error {
  override readonly name = "TickResponseMismatchError";
}

export class RestRequestTimeoutError extends Error {
  override readonly name = "RestRequestTimeoutError";
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_ATTEMPTS = 2;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_BASE_DELAY_MS = 5_000;
const MAX_RETRY_ATTEMPTS = 5;

const retryableTransportFailure = (cause: unknown): boolean => {
  if (cause instanceof RestRequestTimeoutError) return true;
  if (cause instanceof TypeError) return true;
  if (!(cause instanceof Error)) return false;
  if (cause.name === "AbortError" || cause.name === "TimeoutException") return true;
  const status = /Commander returned HTTP (\d{3})/.exec(cause.message)?.[1];
  if (status === undefined) return false;
  const code = Number(status);
  return code === 408 || code === 425 || code === 429 || code >= 500;
};

const decodeConnectResponse = Schema.decodeUnknownEffect(ConnectResponse);
const decodeTickResponse = Schema.decodeUnknownEffect(TickResponse, {
  onExcessProperty: "error",
});

const advanceReportedSnapshot = (
  previous: ReturnType<typeof projectWorld>,
  current: ReturnType<typeof projectWorld>,
  changes: ReturnType<typeof diffSnapshots>,
): ReturnType<typeof projectWorld> => {
  const reportedGroups = new Set([
    ...changes.groups_upserted.map((group) => group.id),
    ...changes.groups_moved.map((group) => group.id),
  ]);
  const previousGroups = new Map(previous.friendly_groups.map((group) => [group.id, group]));
  return {
    ...current,
    friendly_groups: current.friendly_groups.map((group) => {
      const earlier = previousGroups.get(group.id);
      return reportedGroups.has(group.id) || earlier === undefined
        ? group
        : { ...group, position: earlier.position };
    }),
  };
};

/**
 * Command delivery is at-least-once: Commander retains an accepted command
 * until it receives a terminal outcome so it can refund reservations on a
 * later failure. The result outbox is intentionally separate from the durable
 * execution ledger: an acknowledgement is sent once, then promoted only when
 * the receiver's durable world state reaches a terminal condition. The ledger
 * remains as an execution fence across checkpoint/restart.
 */
const upsertCommandResults = (
  current: readonly CommandResult[],
  updates: readonly CommandResult[],
): CommandResult[] => {
  const indexed = new Map(current.map((result) => [result.command_id, result]));
  for (const result of updates) indexed.set(result.command_id, result);
  return [...indexed.values()];
};

const commandLifecycleKey = (commandId: string): string => commandId;

type CommandExecution = NonNullable<RestCommanderLinkCommandLifecycle["execution"]>;

const sameVector = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const distance2d = (left: readonly number[], right: readonly number[]): number =>
  Math.hypot(left[0]! - right[0]!, left[2]! - right[2]!);

const executionForCommand = (world: SimWorldState, command: Command): CommandExecution => {
  switch (command.type) {
    case "spawn_group":
    case "despawn_group":
    case "set_objective":
      return { kind: "immediate" };
    case "move_group":
    case "attack_group":
    case "defend_group":
    case "patrol_group":
    case "sweep_group": {
      const group = world.groups[command.params.group_id];
      const order = group?.order;
      const expectedKind =
        command.type === "move_group"
          ? "forced_move"
          : command.type === "attack_group"
            ? "attack"
            : command.type === "defend_group"
              ? "defend"
              : command.type === "patrol_group"
                ? "patrol"
                : "sweep";
      if (order === undefined || order.kind !== expectedKind) {
        throw new Error(`Command ${command.command_id} did not install its expected waypoint`);
      }
      return {
        kind: "waypoint",
        group_id: command.params.group_id,
        waypoint_kind: order.kind,
        destination: [...order.destination],
        radius: order.radius,
        issued_at_tick: order.issuedAtTick,
      };
    }
  }
};

export class RestCommanderLink {
  readonly #options: Required<
    Pick<
      RestCommanderLinkOptions,
      | "fullSnapshotInterval"
      | "detectionRangeMeters"
      | "contactExpirySeconds"
      | "now"
      | "requestTimeoutMs"
      | "retryBaseDelayMs"
      | "retryMaxAttempts"
    >
  > &
    Omit<
      RestCommanderLinkOptions,
      | "fullSnapshotInterval"
      | "detectionRangeMeters"
      | "contactExpirySeconds"
      | "requestTimeoutMs"
      | "retryBaseDelayMs"
      | "retryMaxAttempts"
      | "fetch"
      | "transport"
      | "now"
    >;
  readonly #transportLayer: Layer.Layer<Transport>;
  readonly #tickSemaphore = Semaphore.makeUnsafe(1);
  readonly #events = new EventFilter();
  readonly #sergeants = new SergeantReporter();
  #tickId = 0;
  #lastSnapshot: ReturnType<typeof projectWorld> | undefined;
  #lastFullTick = 0;
  #forceFull = true;
  #pendingResults: CommandResult[] = [];
  #commandLedger = new Map<string, RestCommanderLinkCommandLifecycle>();
  #pendingReports: SergeantReport[] = [];
  #tickRateHint = 1_000;
  #nextTickAt = 0;
  #connected = false;
  #fullSnapshotInterval: number;
  #detectionRangeMeters: number;
  #contactExpirySeconds: number;
  #deltaMovementThresholdMeters: number;

  constructor(options: RestCommanderLinkOptions) {
    const fullSnapshotInterval = options.fullSnapshotInterval ?? 30;
    const detectionRangeMeters = options.detectionRangeMeters ?? 300;
    const contactExpirySeconds = options.contactExpirySeconds ?? 180;
    const deltaMovementThresholdMeters = options.deltaMovementThresholdMeters ?? 50;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const retryMaxAttempts = options.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    if (!Number.isInteger(fullSnapshotInterval) || fullSnapshotInterval <= 0) {
      throw new RangeError("fullSnapshotInterval must be a positive integer");
    }
    if (!Number.isFinite(detectionRangeMeters) || detectionRangeMeters <= 0) {
      throw new RangeError("detectionRangeMeters must be a positive finite number");
    }
    if (!Number.isFinite(contactExpirySeconds) || contactExpirySeconds <= 0) {
      throw new RangeError("contactExpirySeconds must be a positive finite number");
    }
    if (!Number.isFinite(deltaMovementThresholdMeters) || deltaMovementThresholdMeters < 0) {
      throw new RangeError("deltaMovementThresholdMeters must be a non-negative finite number");
    }
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new RangeError(
        `requestTimeoutMs must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    if (
      !Number.isInteger(retryBaseDelayMs) ||
      retryBaseDelayMs <= 0 ||
      retryBaseDelayMs > MAX_RETRY_BASE_DELAY_MS
    ) {
      throw new RangeError(
        `retryBaseDelayMs must be an integer from 1 to ${MAX_RETRY_BASE_DELAY_MS}`,
      );
    }
    if (
      !Number.isInteger(retryMaxAttempts) ||
      retryMaxAttempts < 0 ||
      retryMaxAttempts > MAX_RETRY_ATTEMPTS
    ) {
      throw new RangeError(`retryMaxAttempts must be an integer from 0 to ${MAX_RETRY_ATTEMPTS}`);
    }
    const endpoint = options.endpoint.replace(/\/$/, "");
    this.#options = {
      endpoint,
      apiKey: options.apiKey,
      sessionId: options.sessionId,
      faction: options.faction,
      ...(options.missionId === undefined ? {} : { missionId: options.missionId }),
      ...(options.missionName === undefined ? {} : { missionName: options.missionName }),
      ...(options.missionEpoch === undefined ? {} : { missionEpoch: options.missionEpoch }),
      ...(options.mapName === undefined ? {} : { mapName: options.mapName }),
      ...(options.doctrine === undefined ? {} : { doctrine: options.doctrine }),
      fullSnapshotInterval,
      detectionRangeMeters,
      contactExpirySeconds,
      requestTimeoutMs,
      retryBaseDelayMs,
      retryMaxAttempts,
      now: options.now ?? Date.now,
    };
    this.#fullSnapshotInterval = this.#options.fullSnapshotInterval;
    this.#detectionRangeMeters = this.#options.detectionRangeMeters;
    this.#contactExpirySeconds = this.#options.contactExpirySeconds;
    this.#deltaMovementThresholdMeters = deltaMovementThresholdMeters;
    this.#transportLayer = options.transport
      ? Layer.succeed(Transport, options.transport)
      : RestTransport.layer({
          endpoint,
          apiKey: options.apiKey,
          ...(options.missionEpoch === undefined ? {} : { missionEpoch: options.missionEpoch }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
  }

  get tickRateHint(): number {
    return this.#tickRateHint;
  }

  get connected(): boolean {
    return this.#connected;
  }

  snapshotState(): Promise<RestCommanderLinkState> {
    const snapshot = Effect.sync(
      (): RestCommanderLinkState => ({
        version: REST_COMMANDER_LINK_STATE_VERSION,
        session_id: this.#options.sessionId,
        mission_id: this.#options.missionId ?? this.#options.sessionId,
        mission_name: this.#options.missionName ?? `Poligon ${this.#options.sessionId}`,
        faction: this.#options.faction,
        mission_epoch: this.#options.missionEpoch ?? 1,
        map_name: this.#options.mapName ?? "Poligon Procedural",
        ...(this.#options.doctrine === undefined ? {} : { doctrine: this.#options.doctrine }),
        full_snapshot_interval: this.#fullSnapshotInterval,
        detection_range_meters: this.#detectionRangeMeters,
        contact_expiry_seconds: this.#contactExpirySeconds,
        delta_movement_threshold_meters: this.#deltaMovementThresholdMeters,
        connected: this.#connected,
        tick_id: this.#tickId,
        last_full_tick: this.#lastFullTick,
        ...(this.#lastSnapshot === undefined
          ? {}
          : { last_snapshot: structuredClone(this.#lastSnapshot) }),
        force_full: this.#forceFull,
        pending_results: structuredClone(this.#pendingResults),
        command_ledger: structuredClone(
          [...this.#commandLedger.values()].sort((left, right) =>
            left.result.command_id.localeCompare(right.result.command_id),
          ),
        ),
        pending_reports: structuredClone(this.#pendingReports),
        tick_rate_hint: this.#tickRateHint,
        next_tick_at: this.#nextTickAt,
        event_filter: this.#events.snapshotState(),
        sergeant_reporter: this.#sergeants.snapshotState(),
      }),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RestCommanderLinkState)));
    return Effect.runPromise(this.#tickSemaphore.withPermits(1)(snapshot));
  }

  restoreState(snapshot: unknown): Promise<void> {
    const expectedEpoch = this.#options.missionEpoch ?? 1;
    const expectedMap = this.#options.mapName ?? "Poligon Procedural";
    const expectedMissionId = this.#options.missionId ?? this.#options.sessionId;
    const expectedMissionName = this.#options.missionName ?? `Poligon ${this.#options.sessionId}`;
    const restore = Schema.decodeUnknownEffect(RestCommanderLinkState)(snapshot).pipe(
      Effect.flatMap((state) =>
        state.session_id === this.#options.sessionId &&
        state.mission_id === expectedMissionId &&
        state.mission_name === expectedMissionName &&
        state.faction === this.#options.faction &&
        state.mission_epoch === expectedEpoch &&
        state.map_name === expectedMap &&
        state.doctrine === this.#options.doctrine
          ? Effect.succeed(state)
          : Effect.fail(
              new RestCommanderLinkStateMismatchError(
                "Persisted link state does not match the configured mission identity",
              ),
            ),
      ),
      Effect.tap((state) =>
        Effect.sync(() => {
          this.#connected = state.connected;
          this.#fullSnapshotInterval = state.full_snapshot_interval;
          this.#detectionRangeMeters = state.detection_range_meters;
          this.#contactExpirySeconds = state.contact_expiry_seconds;
          this.#deltaMovementThresholdMeters = state.delta_movement_threshold_meters;
          this.#tickId = state.tick_id;
          this.#lastFullTick = state.last_full_tick;
          this.#lastSnapshot =
            state.last_snapshot === undefined ? undefined : structuredClone(state.last_snapshot);
          this.#forceFull = state.force_full;
          this.#pendingResults = structuredClone([...state.pending_results]);
          this.#commandLedger = new Map(
            (
              state.command_ledger ??
              state.pending_results.map(
                (result) =>
                  ({
                    result,
                    accepted_sent: false,
                  }) satisfies RestCommanderLinkCommandLifecycle,
              )
            ).map((entry) => [
              commandLifecycleKey(entry.result.command_id),
              structuredClone(entry),
            ]),
          );
          this.#pendingReports = structuredClone([...state.pending_reports]);
          this.#tickRateHint = state.tick_rate_hint;
          this.#nextTickAt = state.next_tick_at;
          this.#events.restoreState(state.event_filter);
          this.#sergeants.restoreState(state.sergeant_reporter);
        }),
      ),
      Effect.asVoid,
    );
    return Effect.runPromise(this.#tickSemaphore.withPermits(1)(restore));
  }

  queueSergeantReport(report: SergeantReport): void {
    this.#sergeants.record(report);
    this.#pendingReports.push(report);
  }

  requestFullSnapshot(): void {
    this.#forceFull = true;
    this.#nextTickAt = 0;
  }

  connect(): Promise<ConnectResponse> {
    const body: ConnectRequest = {
      protocol_version: PROTOCOL_VERSION,
      session_id: this.#options.sessionId,
      mission_id: this.#options.missionId ?? this.#options.sessionId,
      mission_epoch: this.#options.missionEpoch ?? 1,
      faction: this.#options.faction,
      map_name: this.#options.mapName ?? "Poligon Procedural",
      ...(this.#options.doctrine === undefined ? {} : { doctrine: this.#options.doctrine }),
    };
    return Effect.runPromise(
      this.#tickSemaphore.withPermits(1)(
        this.#postEffect("/api/connect", body).pipe(
          Effect.flatMap(decodeConnectResponse),
          Effect.flatMap((response) =>
            Effect.sync(() => {
              this.#connected = response.accepted;
              if (response.accepted) {
                this.#forceFull = true;
                this.#nextTickAt = 0;
                this.#tickRateHint = Math.max(100, response.tick_rate_hint);
              }
            }).pipe(
              Effect.andThen(
                response.accepted
                  ? Effect.succeed(response)
                  : Effect.fail(new ConnectRejectedError("Commander rejected the connection")),
              ),
            ),
          ),
        ),
      ),
    );
  }

  disconnect(reason?: string): Promise<void> {
    const body: DisconnectRequest = {
      protocol_version: PROTOCOL_VERSION,
      session_id: this.#options.sessionId,
      faction: this.#options.faction,
      ...(reason ? { reason } : {}),
    };
    return Effect.runPromise(
      this.#tickSemaphore.withPermits(1)(
        this.#postEffect("/api/disconnect", body).pipe(
          Effect.tap(() => Effect.sync(() => (this.#connected = false))),
          Effect.asVoid,
        ),
      ),
    );
  }

  uploadMap(briefing: MapUploadRequest["briefing"]): Promise<void> {
    const body: MapUploadRequest = {
      protocol_version: PROTOCOL_VERSION,
      session_id: this.#options.sessionId,
      mission_id: this.#options.missionId ?? this.#options.sessionId,
      mission_epoch: this.#options.missionEpoch ?? 1,
      faction: this.#options.faction,
      briefing,
    };
    return Effect.runPromise(this.#postEffect("/api/map", body).pipe(Effect.asVoid));
  }

  shouldTick(world: SimWorldState): boolean {
    if (this.#options.now() >= this.#nextTickAt) return true;
    const projected = this.#project(world);
    const visibleGroupIds = new Set([
      ...Object.values(world.groups)
        .filter((group) => group.faction === this.#options.faction)
        .map((group) => group.id),
      ...(this.#lastSnapshot?.friendly_groups.map((group) => group.id) ?? []),
      ...projected.known_enemies.map((enemy) => enemy.id),
    ]);
    const visibleEvents = filterVisibleEvents(world.events, visibleGroupIds);
    if (
      this.#events.urgentPending ||
      visibleEvents.some((event) => event.significance === "urgent")
    ) {
      return true;
    }
    const simulationSeconds = world.timeMs / 1_000;
    if (
      this.#events.notableDue(simulationSeconds) ||
      visibleEvents.some(
        (event) => event.significance === "notable" && simulationSeconds - event.timestamp >= 10,
      )
    ) {
      return true;
    }
    const previousContacts = new Set(
      (this.#lastSnapshot?.known_enemies ?? [])
        .filter((enemy) => enemy.age_seconds === 0)
        .map((enemy) => `${enemy.reported_by}\0${enemy.id}`),
    );
    return projected.known_enemies.some(
      (enemy) => !previousContacts.has(`${enemy.reported_by}\0${enemy.id}`),
    );
  }

  tickIfDue(world: SimWorldState): Promise<TickOutcome | undefined> {
    return this.shouldTick(world) ? this.tick(world) : Promise.resolve(undefined);
  }

  tick(world: SimWorldState): Promise<TickOutcome> {
    const work = Effect.gen({ self: this }, function* () {
      const tickStartedAt = this.#options.now();
      this.#tickId += 1;
      const projected = this.#project(world);
      const previousSnapshot = this.#lastSnapshot;
      const elapsedSeconds = previousSnapshot
        ? Math.max(
            0,
            projected.mission.time_elapsed_seconds - previousSnapshot.mission.time_elapsed_seconds,
          )
        : 0;
      const snapshot = {
        ...projected,
        known_enemies: decayKnownEnemies(
          previousSnapshot?.known_enemies ?? [],
          projected.known_enemies,
          elapsedSeconds,
          this.#contactExpirySeconds,
        ),
      };
      const worldEvents = drainEvents(world);
      const visibleEventGroupIds = new Set([
        ...snapshot.friendly_groups.map((group) => group.id),
        ...(previousSnapshot?.friendly_groups.map((group) => group.id) ?? []),
        ...projected.known_enemies.map((enemy) => enemy.id),
      ]);
      const eventBatch = this.#events.ingest(
        filterVisibleEvents(worldEvents, visibleEventGroupIds),
        world.timeMs / 1_000,
      );
      const pendingReportGroups = new Set(
        this.#pendingReports.map((report) => report.payload.group_id),
      );
      const generatedReports = this.#sergeants.generate({
        snapshot,
        visibleEnemies: projected.known_enemies,
        events: eventBatch.events,
        timestamp: world.timeMs / 1_000,
        ...(previousSnapshot === undefined ? {} : { previousSnapshot }),
      });
      this.#pendingReports.push(
        ...generatedReports.filter((report) => !pendingReportGroups.has(report.payload.group_id)),
      );
      const sendFull =
        this.#forceFull ||
        !previousSnapshot ||
        this.#tickId - this.#lastFullTick >= this.#fullSnapshotInterval;
      const common = {
        protocol_version: PROTOCOL_VERSION,
        session_id: this.#options.sessionId,
        faction: this.#options.faction,
        tick_id: this.#tickId,
        timestamp: tickStartedAt / 1_000,
        full_snapshot_interval: this.#fullSnapshotInterval,
        sergeant_reports: this.#pendingReports.splice(0),
        events: [...eventBatch.events],
        command_results: structuredClone(this.#pendingResults),
      } as const;
      const request: TickRequest = sendFull
        ? { ...common, type: "full", snapshot }
        : {
            ...common,
            type: "delta",
            since_tick: this.#tickId - 1,
            changes: diffSnapshots(
              previousSnapshot as ReturnType<typeof projectWorld>,
              snapshot,
              this.#deltaMovementThresholdMeters,
            ),
          };

      const response = yield* this.#postEffect("/api/tick", request).pipe(
        Effect.flatMap(decodeTickResponse),
        Effect.flatMap((decoded) =>
          decoded.tick_id === request.tick_id
            ? Effect.succeed(decoded)
            : Effect.fail(
                new TickResponseMismatchError(
                  `Commander response tick ${decoded.tick_id} does not match request ${request.tick_id}`,
                ),
              ),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            this.#forceFull = true;
            this.#nextTickAt = 0;
            this.#events.restore(request.events);
            this.#pendingReports.unshift(...request.sergeant_reports);
          }),
        ),
      );

      this.#settleDeliveredCommandResults(world, request.command_results);
      const commandResults = response.commands.map((command): CommandResult => {
        const prior = this.#commandLedger.get(commandLifecycleKey(command.command_id));
        if (prior !== undefined) {
          this.#requeuePriorCommandResult(prior);
          return prior.result;
        }
        try {
          executeCommand(world, command, this.#options.faction);
          const result: CommandResult = { command_id: command.command_id, status: "accepted" };
          this.#recordCommandResult(result, false, executionForCommand(world, command));
          return result;
        } catch (error) {
          const result: CommandResult = {
            command_id: command.command_id,
            status: "failed",
            reason: error instanceof Error ? error.message : "Unknown command error",
          };
          this.#recordCommandResult(result, true);
          return result;
        }
      });
      this.#lastSnapshot =
        request.type === "full"
          ? snapshot
          : advanceReportedSnapshot(
              previousSnapshot as ReturnType<typeof projectWorld>,
              snapshot,
              request.changes,
            );
      this.#applyConfigUpdates(response.config_updates);
      this.#forceFull = response.request_full_snapshot;
      if (sendFull) this.#lastFullTick = this.#tickId;
      this.#tickRateHint = Math.max(100, response.tick_rate_hint);
      this.#nextTickAt = tickStartedAt + this.#tickRateHint;
      this.#connected = response.commander_status.connected;
      return { request, response, commandResults };
    });

    return Effect.runPromise(
      this.#tickSemaphore
        .withPermitsIfAvailable(1)(work)
        .pipe(
          Effect.flatMap((outcome) =>
            Option.isSome(outcome)
              ? Effect.succeed(outcome.value)
              : Effect.fail(new TickInFlightError("Only one REST tick may be in flight")),
          ),
        ),
    );
  }

  #project(world: SimWorldState) {
    return projectWorld(world, this.#options.faction, {
      sessionId: this.#options.sessionId,
      ...(this.#options.missionId === undefined ? {} : { missionId: this.#options.missionId }),
      ...(this.#options.missionName === undefined
        ? {}
        : { missionName: this.#options.missionName }),
      ...(this.#options.missionEpoch === undefined
        ? {}
        : { missionEpoch: this.#options.missionEpoch }),
      ...(this.#options.mapName === undefined ? {} : { mapName: this.#options.mapName }),
      detectionRangeMeters: this.#detectionRangeMeters,
    });
  }

  #postEffect(path: string, body: unknown) {
    const program = Effect.gen(function* () {
      const transport = yield* Transport;
      return yield* transport.postJson(path, body);
    });

    return program.pipe(
      Effect.provide(this.#transportLayer),
      Effect.timeoutOrElse({
        duration: `${this.#options.requestTimeoutMs} millis`,
        orElse: () =>
          Effect.fail(new RestRequestTimeoutError(`Commander ${path} request timed out`)),
      }),
      Effect.retry({
        schedule: Schedule.exponential(`${this.#options.retryBaseDelayMs} millis`).pipe(
          Schedule.upTo({ times: this.#options.retryMaxAttempts }),
        ),
        while: retryableTransportFailure,
      }),
    );
  }

  #applyConfigUpdates(updates: CommanderConfigUpdates): void {
    if (updates.full_snapshot_interval !== undefined) {
      this.#fullSnapshotInterval = updates.full_snapshot_interval;
    }
    if (updates.detection_range_meters !== undefined) {
      this.#detectionRangeMeters = updates.detection_range_meters;
    }
    if (updates.contact_expiry_seconds !== undefined) {
      this.#contactExpirySeconds = updates.contact_expiry_seconds;
    }
    if (updates.delta_movement_threshold_meters !== undefined) {
      this.#deltaMovementThresholdMeters = updates.delta_movement_threshold_meters;
    }
  }

  #recordCommandResult(
    result: CommandResult,
    acceptedSent: boolean,
    execution?: CommandExecution,
  ): void {
    this.#commandLedger.set(commandLifecycleKey(result.command_id), {
      result,
      accepted_sent: acceptedSent,
      ...(execution === undefined ? {} : { execution }),
    });
    this.#pendingResults = upsertCommandResults(this.#pendingResults, [result]);
  }

  #requeuePriorCommandResult(entry: RestCommanderLinkCommandLifecycle): void {
    this.#pendingResults = upsertCommandResults(this.#pendingResults, [entry.result]);
  }

  /**
   * A successful response proves the result batch reached Commander, but not
   * that a waypoint has finished. Keep accepted orders in the durable ledger
   * and only publish their terminal state after the receiver world says so.
   */
  #settleDeliveredCommandResults(world: SimWorldState, delivered: readonly CommandResult[]): void {
    const terminalIds = new Set<string>();
    for (const result of delivered) {
      const key = commandLifecycleKey(result.command_id);
      const entry = this.#commandLedger.get(key);
      if (entry === undefined) continue;
      if (result.status === "accepted" && entry.result.status === "accepted") {
        this.#commandLedger.set(key, { ...entry, accepted_sent: true });
      } else if (result.status !== "accepted") {
        terminalIds.add(result.command_id);
      }
    }
    if (terminalIds.size > 0) {
      this.#pendingResults = this.#pendingResults.filter(
        (result) => !terminalIds.has(result.command_id),
      );
    }
    this.#advanceCommandLifecycles(world);
  }

  #advanceCommandLifecycles(world: SimWorldState): void {
    for (const entry of this.#commandLedger.values()) {
      if (entry.result.status !== "accepted" || !entry.accepted_sent) continue;
      const terminal = this.#terminalCommandResult(entry, world);
      if (terminal === undefined) continue;
      const next: RestCommanderLinkCommandLifecycle = {
        ...entry,
        result: terminal,
      };
      this.#commandLedger.set(commandLifecycleKey(terminal.command_id), next);
      this.#pendingResults = upsertCommandResults(this.#pendingResults, [terminal]);
    }
  }

  #terminalCommandResult(
    entry: RestCommanderLinkCommandLifecycle,
    world: SimWorldState,
  ): CommandResult | undefined {
    const execution = entry.execution;
    if (execution === undefined) return undefined;
    if (execution.kind === "immediate") {
      return { command_id: entry.result.command_id, status: "completed" };
    }

    const group = world.groups[execution.group_id];
    if (group === undefined) {
      return {
        command_id: entry.result.command_id,
        status: "failed",
        reason: `Receiver group ${execution.group_id} no longer exists`,
      };
    }
    const order = group.order;
    if (
      order === undefined ||
      order.kind !== execution.waypoint_kind ||
      order.issuedAtTick !== execution.issued_at_tick ||
      !sameVector(order.destination, execution.destination) ||
      order.radius !== execution.radius
    ) {
      return {
        command_id: entry.result.command_id,
        status: "failed",
        reason: `Receiver order for ${execution.group_id} was superseded`,
      };
    }

    // Patrol and defend are persistent postures in sim-core. They remain
    // accepted until explicitly superseded or their receiver disappears.
    if (execution.waypoint_kind === "defend" || execution.waypoint_kind === "patrol") {
      return undefined;
    }
    // Attack and sweep remain active while combat is in progress even if the
    // group has reached the initial destination.
    if (group.status === "engaged") return undefined;
    return distance2d(group.position, execution.destination) <= execution.radius
      ? { command_id: entry.result.command_id, status: "completed" }
      : undefined;
  }
}

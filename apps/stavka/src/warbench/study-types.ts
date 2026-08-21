import type { ScenarioFamily } from "@stavka/warbench-core";

/**
 * Study manifest and result contracts shared by the immutable study-store
 * Durable Object and the Warbench feature service. Kept free of Worker
 * runtime imports so both sides and their tests can use them anywhere.
 */

export type StudyStatus = "draft" | "running" | "completed" | "invalidated";
export type StudyArm = "rule" | "codex";

export interface StudyManifest {
  readonly id: string;
  readonly status: StudyStatus;
  readonly protocolVersion: string;
  readonly evidenceSchemaVersion: number;
  readonly gitSha: string;
  readonly piVersion: string;
  readonly modelId: string;
  readonly promptHash: string;
  readonly seeds: readonly number[];
  readonly families: readonly ScenarioFamily[];
  readonly decisionEveryTicks: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface StudyResult {
  readonly studyId: string;
  /** Immutable studies never allow a second attempt for the same slot. */
  readonly attempt: 1;
  readonly recordedAt: string;

  // SeedResult-compatible evidence fields.
  readonly schemaVersion?: number;
  readonly seed: number;
  readonly family: ScenarioFamily;
  readonly controller: StudyArm;
  readonly score: number;
  readonly opponentScore: number;
  readonly won: boolean;
  readonly invalidDecisions: number;
  readonly requestFailures?: number;
  readonly decisionCount: number;
  readonly decisionLatenciesMs: readonly number[];
  readonly failureMessages?: readonly string[];
  readonly model?: string;
}

import { DurableObject } from "cloudflare:workers";
import type { ScenarioFamily, SeedResult } from "@stavka/warbench-core";

/**
 * Append-only, immutable benchmark evidence store.
 *
 * Replaces the standalone Warbench BenchmarkStore whose
 * `controller:family:seed` keys allowed silent overwrites and cherry-picking.
 * Final results cannot be overwritten, individual seeds cannot be selectively
 * rerun, and repeating evidence requires invalidating the whole study and
 * creating a new one.
 */

export interface StudyManifest {
  readonly id: string;
  readonly status: "draft" | "running" | "completed" | "invalidated";
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

export interface StudyResult extends SeedResult {
  readonly studyId: string;
  /** Immutable studies never allow a second attempt for the same slot. */
  readonly attempt: 1;
  readonly recordedAt: string;
}

export type StudyReportKind = "json" | "pdf";

export class StudyConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "StudyConflictError";
  }
}

export class StudyStateError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "StudyStateError";
  }
}

export class StudyNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "StudyNotFoundError";
  }
}

const resultKey = (studyId: string, arm: string, family: string, seed: number): string =>
  `study:${studyId}:result:${arm}:${family}:${seed}`;

const digestOver = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const assertStudyId = (studyId: string): void => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(studyId)) {
    throw new StudyStateError("study id must be alphanumeric with dashes or underscores");
  }
};

export interface StudyEvidence {
  readonly manifest: StudyManifest;
  readonly results: readonly StudyResult[];
  readonly digest: string;
}

export class WarbenchStudyStore extends DurableObject<Record<string, never>> {
  async createStudy(manifest: StudyManifest): Promise<void> {
    assertStudyId(manifest.id);
    const key = `study:${manifest.id}:manifest`;
    if ((await this.ctx.storage.get(key)) !== undefined) {
      throw new StudyConflictError(`study ${manifest.id} already exists`);
    }
    await this.ctx.storage.put(key, manifest);
  }

  async getStudy(studyId: string): Promise<StudyManifest | undefined> {
    assertStudyId(studyId);
    return this.ctx.storage.get<StudyManifest>(`study:${studyId}:manifest`);
  }

  /**
   * Record one final seed result. The write fails with HTTP 409 semantics if
   * the slot is already filled or the study has completed.
   */
  async recordResult(result: StudyResult): Promise<void> {
    assertStudyId(result.studyId);
    if (result.attempt !== 1) {
      throw new StudyStateError("study results are single-attempt");
    }
    const study = await this.getStudy(result.studyId);
    if (!study) throw new StudyNotFoundError(`unknown study ${result.studyId}`);
    if (study.status === "completed" || study.status === "invalidated") {
      throw new StudyConflictError(
        `study ${result.studyId} is ${study.status}; evidence requires a new study`,
      );
    }
    const arm = result.controller;
    const key = resultKey(result.studyId, arm, result.family, result.seed);
    const existing = await this.ctx.storage.get(key);
    if (existing !== undefined) {
      throw new StudyConflictError(
        `result ${result.family}/${result.seed} (${arm}) already recorded for study ${result.studyId}`,
      );
    }
    await this.ctx.storage.put(key, result);
  }

  async listResults(studyId: string): Promise<StudyResult[]> {
    assertStudyId(studyId);
    const prefix = `study:${studyId}:result:`;
    const entries = await this.ctx.storage.list({ prefix });
    return [...entries.values()] as StudyResult[];
  }

  /**
   * Complete a study and freeze its evidence digest. Completing is terminal:
   * completed studies cannot be cleared or extended.
   */
  async completeStudy(studyId: string): Promise<string> {
    const study = await this.getStudy(studyId);
    if (!study) throw new StudyNotFoundError(`unknown study ${studyId}`);
    if (study.status === "invalidated") {
      throw new StudyStateError("an invalidated study can never be completed");
    }
    if (study.status === "completed") {
      throw new StudyConflictError(`study ${studyId} is already completed`);
    }
    const results = await this.listResults(studyId);
    const completed: StudyManifest = {
      ...study,
      status: "completed",
      ...(study.completedAt ? {} : { completedAt: new Date().toISOString() }),
    };
    const digest = await digestOver({ manifest: completed, results });
    // The digest itself becomes immutable once written.
    if ((await this.ctx.storage.get(`study:${studyId}:digest`)) === undefined) {
      await this.ctx.storage.put(`study:${studyId}:digest`, digest);
    }
    await this.ctx.storage.put(`study:${studyId}:manifest`, completed);
    return digest;
  }

  /**
   * Invalidate a study so a corrected rerun can start elsewhere. Existing
   * rows are retained for audit but are permanently non-evidentiary.
   */
  async invalidateStudy(studyId: string): Promise<void> {
    const study = await this.getStudy(studyId);
    if (!study) throw new StudyNotFoundError(`unknown study ${studyId}`);
    if (study.status === "completed") {
      throw new StudyConflictError("completed studies cannot be cleared or invalidated");
    }
    await this.ctx.storage.put(`study:${studyId}:manifest`, {
      ...study,
      status: "invalidated",
    } satisfies StudyManifest);
  }

  async putReport(studyId: string, kind: StudyReportKind, bytes: Uint8Array): Promise<string> {
    const study = await this.getStudy(studyId);
    if (!study) throw new StudyNotFoundError(`unknown study ${studyId}`);
    if (study.status !== "completed") {
      throw new StudyStateError("reports derive only from completed studies");
    }
    const digest = await digestOver(bytes);
    const encoded = bytesToBase64(bytes);
    const existing = await this.ctx.storage.get<string>(`study:${studyId}:report:${kind}`);
    if (existing !== undefined && existing !== encoded) {
      throw new StudyConflictError(`report ${kind} for study ${studyId} is already frozen`);
    }
    await this.ctx.storage.put(`study:${studyId}:report:${kind}`, encoded);
    return digest;
  }

  async getReport(studyId: string, kind: StudyReportKind): Promise<Uint8Array | undefined> {
    const base64 = await this.ctx.storage.get<string>(`study:${studyId}:report:${kind}`);
    return base64 === undefined ? undefined : base64ToBytes(base64);
  }

  /** Full evidence including the digest over manifest and results. */
  async evidence(studyId: string): Promise<StudyEvidence> {
    const manifest = await this.getStudy(studyId);
    if (!manifest) throw new StudyNotFoundError(`unknown study ${studyId}`);
    const results = await this.listResults(studyId);
    return {
      manifest,
      results,
      digest: await digestOver({ manifest, results }),
    };
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

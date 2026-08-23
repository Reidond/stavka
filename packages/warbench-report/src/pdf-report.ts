import type { StudyEvidenceObject } from "@stavka/warbench-core";

const escapePdf = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const number = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "n/a");

const wrapLine = (line: string, width = 88): string[] => {
  if (line.length <= width) return [line];
  const words = line.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = `  ${word}`;
    }
  }
  if (current) lines.push(current);
  return lines;
};

export const studyEvidenceReportLines = (evidence: StudyEvidenceObject): string[] => {
  const { manifest, hypothesis, baseline, candidate, paired } = evidence;
  const plannedSlots = manifest.families.length * manifest.seeds.length * 2;
  const lines = [
    "Warbench - Independent LLM Commander Hypothesis Test",
    `Study ID: ${manifest.id}`,
    `Study state: ${manifest.status}`,
    `Mechanical verdict: ${hypothesis.status}`,
    `Git commit: ${manifest.gitSha}`,
    `Protocol version: ${manifest.protocolVersion}`,
    `Evidence schema version: ${manifest.evidenceSchemaVersion}`,
    `Provider version: ${manifest.providerVersion ?? `pi/${manifest.piVersion ?? "unknown"}`}`,
    `Exact model ID: ${manifest.modelId}`,
    `Prompt SHA-256: ${manifest.promptHash}`,
    `Created: ${manifest.createdAt}`,
    `Started: ${manifest.startedAt ?? "not started"}`,
    `Completed: ${manifest.completedAt ?? "not completed"}`,
    `Study digest: ${evidence.digest}`,
    `Planned slots: ${plannedSlots}`,
    `Completed slots: ${evidence.results.length}`,
    `Minimum sample ready: ${hypothesis.sampleReady ? "yes" : "no"}`,
    `Valid live-model evidence ready: ${hypothesis.evidenceReady ? "yes" : "no"}`,
    "",
    "Acceptance gates",
    `Mean score improvement >= 5%: ${hypothesis.gates.meanScoreImprovement ? "PASS" : "FAIL"}`,
    `Win-rate improvement >= 5 percentage points: ${hypothesis.gates.winRateImprovement ? "PASS" : "FAIL"}`,
    `Invalid model decisions <= 2%: ${hypothesis.gates.invalidDecisionRate ? "PASS" : "FAIL"}`,
    `Provider request failures <= 2%: ${hypothesis.gates.requestReliability ? "PASS" : "FAIL"}`,
    `Successful model-response latency p95 <= 5000 ms: ${hypothesis.gates.latency ? "PASS" : "FAIL"}`,
    `No scenario-family regression worse than 10%: ${hypothesis.gates.familyRegression ? "PASS" : "FAIL"}`,
    "",
    "Rule baseline",
    `Runs: ${baseline.runs}`,
    `Mean score: ${number(baseline.meanScore)}`,
    `Win rate: ${percent(baseline.winRate)}`,
  ];

  if (candidate) {
    lines.push(
      "",
      "Codex candidate",
      `Runs: ${candidate.runs}`,
      `Mean score: ${number(candidate.meanScore)}`,
      `Win rate: ${percent(candidate.winRate)}`,
      `Actual model responses: ${candidate.modelResponseCount}`,
      `Invalid model decision rate: ${percent(candidate.invalidDecisionRate)}`,
      `Provider request failure rate: ${percent(candidate.requestFailureRate)}`,
      `Successful response latency p95: ${number(candidate.p95DecisionLatencyMs)} ms`,
      `Legacy evidence rows: ${candidate.legacyRuns}`,
      "",
      "Scenario families",
    );
    for (const [family, familyCandidate] of Object.entries(candidate.families)) {
      const familyBaseline = baseline.families[family as keyof typeof baseline.families];
      lines.push(
        `${family}: rule score ${number(familyBaseline.meanScore)}, Codex score ${number(familyCandidate.meanScore)}, rule wins ${percent(familyBaseline.winRate)}, Codex wins ${percent(familyCandidate.winRate)}, model responses ${familyCandidate.modelResponses}, request failures ${familyCandidate.requestFailures}`,
      );
    }
    if (candidate.failureMessages.length > 0) {
      lines.push("", "Sanitized provider/model failures");
      for (const message of candidate.failureMessages) lines.push(`- ${message}`);
    }
  } else {
    lines.push("", "Codex candidate: no results recorded.");
  }

  lines.push(
    "",
    "Paired analysis (candidate score - baseline score)",
    `Pairs: ${paired.pairs}`,
    `Mean paired delta: ${number(paired.meanScoreDelta)}`,
    `Median paired delta: ${number(paired.medianScoreDelta)}`,
    `Improved / tied / regressed: ${paired.improved} / ${paired.tied} / ${paired.regressed}`,
    `Deterministic 95% bootstrap CI: ${number(paired.confidence95.lower)} to ${number(paired.confidence95.upper)}`,
  );
  for (const [family, analysis] of Object.entries(paired.families)) {
    lines.push(
      `${family}: pairs ${analysis.pairs}, mean delta ${number(analysis.meanScoreDelta)}, median delta ${number(analysis.medianScoreDelta)}, improved/tied/regressed ${analysis.improved}/${analysis.tied}/${analysis.regressed}`,
    );
  }

  lines.push(
    "",
    "Limitations",
    "- This study tests one pinned model, prompt, simulator protocol, and deterministic scenario set.",
    "- It does not test Arma Reforger integration, real-world tactics, or military competence.",
    "- Provider failures and invalid outputs remain evidence and are not selectively retried.",
  );
  if (!hypothesis.evidenceReady) {
    lines.push(
      "- The result is INCONCLUSIVE because the minimum current-schema live-model evidence is incomplete.",
    );
  } else if (hypothesis.status === "PASS" && paired.confidence95.lower <= 0) {
    lines.push("- Product gates passed, but the paired confidence interval crosses zero.");
  }
  return lines.flatMap((line) => wrapLine(line));
};

const pageContent = (lines: readonly string[], page: number, pages: number): string => {
  const commands = ["BT", "/F1 9 Tf", "48 794 Td", "12 TL"];
  for (const line of lines) commands.push(`(${escapePdf(line)}) Tj`, "T*");
  commands.push("T*", `(Page ${page} of ${pages}) Tj`, "ET");
  return commands.join("\n");
};

export const renderStudyEvidencePdf = (evidence: StudyEvidenceObject): Uint8Array => {
  const lines = studyEvidenceReportLines(evidence);
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += 54) {
    chunks.push(lines.slice(index, index + 54));
  }

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const content = pageContent(chunk, index + 1, chunks.length);
    const contentId = add(
      `<< /Length ${new TextEncoder().encode(content).byteLength} >>\nstream\n${content}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(output).byteLength);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(output).byteLength;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(output);
};

import type { HypothesisResult } from "@stavka/warbench-core";

const escapePdf = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const number = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "n/a");

const reportLines = (result: HypothesisResult): string[] => {
  const lines = [
    "Warbench - Independent LLM Commander Hypothesis Test",
    `Generated: ${new Date().toISOString()}`,
    `Conclusion: ${result.status}`,
    `Minimum sample ready: ${result.sampleReady ? "yes" : "no"}`,
    `Valid live-model evidence ready: ${result.evidenceReady ? "yes" : "no"}`,
    "",
    "Acceptance criteria",
    `Mean score improvement >= 5%: ${result.gates.meanScoreImprovement ? "PASS" : "FAIL"}`,
    `Win-rate improvement >= 5 percentage points: ${result.gates.winRateImprovement ? "PASS" : "FAIL"}`,
    `Invalid model decisions <= 2%: ${result.gates.invalidDecisionRate ? "PASS" : "FAIL"}`,
    `Provider request failures <= 2%: ${result.gates.requestReliability ? "PASS" : "FAIL"}`,
    `Successful model-response latency p95 <= 5000 ms: ${result.gates.latency ? "PASS" : "FAIL"}`,
    `No scenario family regression worse than 10%: ${result.gates.familyRegression ? "PASS" : "FAIL"}`,
    "",
    "Rule baseline",
    `Runs: ${result.baseline.runs}`,
    `Mean score: ${number(result.baseline.meanScore)}`,
    `Win rate: ${percent(result.baseline.winRate)}`,
  ];

  if (result.candidate) {
    lines.push(
      "",
      "Codex candidate",
      `Runs: ${result.candidate.runs}`,
      `Mean score: ${number(result.candidate.meanScore)}`,
      `Win rate: ${percent(result.candidate.winRate)}`,
      `Actual model responses: ${result.candidate.modelResponseCount}`,
      `Invalid model decision rate: ${percent(result.candidate.invalidDecisionRate)}`,
      `Provider request failure rate: ${percent(result.candidate.requestFailureRate)}`,
      `Successful response latency p95: ${number(result.candidate.p95DecisionLatencyMs)} ms`,
      `Legacy evidence rows: ${result.candidate.legacyRuns}`,
      "",
      "Scenario families",
    );
    for (const [family, candidate] of Object.entries(result.candidate.families)) {
      const baseline = result.baseline.families[family as keyof typeof result.baseline.families];
      lines.push(
        `${family}: rule score ${number(baseline.meanScore)}, Codex score ${number(candidate.meanScore)}, rule wins ${percent(baseline.winRate)}, Codex wins ${percent(candidate.winRate)}, model responses ${candidate.modelResponses}, request failures ${candidate.requestFailures}`,
      );
    }
    if (result.candidate.failureMessages.length > 0) {
      lines.push("", "Observed provider/model failures");
      for (const message of result.candidate.failureMessages) lines.push(`- ${message}`);
    }
  } else {
    lines.push("", "Codex candidate: no live results recorded.");
  }

  lines.push("");
  if (!result.evidenceReady) {
    lines.push(
      "This report is INCONCLUSIVE because it does not contain valid live-model evidence for every scenario family.",
      "Clear legacy rows, pass the Codex connection probe, and rerun both study arms.",
    );
  } else if (result.status === "INCONCLUSIVE") {
    lines.push("Complete the minimum required sample before interpreting the hypothesis.");
  } else {
    lines.push(
      "This conclusion was computed mechanically from valid live-model evidence and the acceptance gates above.",
    );
  }
  return lines;
};

const pageContent = (lines: readonly string[]): string => {
  const commands = ["BT", "/F1 10 Tf", "50 790 Td", "13 TL"];
  for (const line of lines) {
    commands.push(`(${escapePdf(line)}) Tj`, "T*");
  }
  commands.push("ET");
  return commands.join("\n");
};

export const renderHypothesisPdf = (result: HypothesisResult): Uint8Array => {
  const lines = reportLines(result);
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += 48)
    chunks.push(lines.slice(index, index + 48));

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const chunk of chunks) {
    const content = pageContent(chunk);
    const contentId = add(
      `<< /Length ${new TextEncoder().encode(content).byteLength} >>\nstream\n${content}\nendstream`,
    );
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(new TextEncoder().encode(output).byteLength);
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(output).byteLength;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(output);
};

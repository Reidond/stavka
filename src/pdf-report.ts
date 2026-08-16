import type { HypothesisResult } from "./benchmark";

const escapePdf = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const number = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : "n/a";

const reportLines = (result: HypothesisResult): string[] => {
  const lines = [
    "Warbench - Independent LLM Commander Hypothesis Test",
    `Generated: ${new Date().toISOString()}`,
    `Conclusion: ${result.status}`,
    `Minimum sample ready: ${result.sampleReady ? "yes" : "no"}`,
    "",
    "Acceptance criteria",
    `Mean score improvement >= 5%: ${result.gates.meanScoreImprovement ? "PASS" : "FAIL"}`,
    `Win-rate improvement >= 5 percentage points: ${result.gates.winRateImprovement ? "PASS" : "FAIL"}`,
    `Invalid decisions <= 2%: ${result.gates.invalidDecisionRate ? "PASS" : "FAIL"}`,
    `Decision latency p95 <= 5000 ms: ${result.gates.latency ? "PASS" : "FAIL"}`,
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
      `Invalid decision rate: ${percent(result.candidate.invalidDecisionRate)}`,
      `Decision latency p95: ${number(result.candidate.p95DecisionLatencyMs)} ms`,
      "",
      "Scenario families",
    );
    for (const [family, candidate] of Object.entries(result.candidate.families)) {
      const baseline = result.baseline.families[family as keyof typeof result.baseline.families];
      lines.push(
        `${family}: rule score ${number(baseline.meanScore)}, Codex score ${number(candidate.meanScore)}, rule wins ${percent(baseline.winRate)}, Codex wins ${percent(candidate.winRate)}`,
      );
    }
  } else {
    lines.push("", "Codex candidate: no live results recorded.");
  }

  lines.push(
    "",
    result.status === "INCONCLUSIVE"
      ? "This report is not evidence that the hypothesis passed or failed. Complete the required live sample."
      : "This conclusion was computed mechanically from the acceptance gates above.",
  );
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
  for (let index = 0; index < lines.length; index += 48) chunks.push(lines.slice(index, index + 48));

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
    const contentId = add(`<< /Length ${new TextEncoder().encode(content).byteLength} >>\nstream\n${content}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

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

export { DecisionLogEntry } from "@stavka/protocol";

export const decisionId = (sequence: number): string => `dec_${String(sequence).padStart(6, "0")}`;

export type OrchestrationMode = "adaptive" | "hierarchical" | "single";

export function orchestrationMode(value = process.env.SPAWN_ORCHESTRATION): OrchestrationMode {
  if (!value) return "adaptive";
  if (value === "adaptive" || value === "hierarchical" || value === "single") return value;
  throw new Error(`Invalid SPAWN_ORCHESTRATION: ${value}; use adaptive, hierarchical or single`);
}

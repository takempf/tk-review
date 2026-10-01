import type { ReviewEngine } from "../ipc/git";

export const ENGINE_LABELS: Record<ReviewEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

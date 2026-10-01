import { useEffect, useState } from "react";
import { Button, cx } from "tk-design-system";
import { type AgentRunKind, useTab } from "../../store/tabStore";
import css from "./RunProgress.module.css";

/** Silence worth pointing out: a working agent writes far more often than this. */
const QUIET_NOTICE_MS = 2 * 60_000;
/** When the backend gives up on a silent run. Keep in step with `QUIET_LIMIT` in `src-tauri/src/runs.rs`. */
const QUIET_LIMIT_MINUTES = 15;

/** The time now, kept current to the second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** `4:07`, or `1:02:45` past the hour. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)} min ago`;
}

/**
 * How long an agent run has been going and when its CLI last wrote anything,
 * so a slow run can be told from a stuck one, and a way to stop it. `kind`
 * picks the run to time; `cancels` is every kind Cancel stops, since pressing
 * Review can start an explanation alongside the review.
 */
export function RunProgress({
  kind,
  cancels = [kind],
  agent,
  className,
}: {
  kind: AgentRunKind;
  cancels?: AgentRunKind[];
  /** Who is working: "Codex". */
  agent: string;
  className?: string;
}) {
  const run = useTab((state) =>
    Object.values(state.agentRuns).find((candidate) => candidate.kind === kind),
  );
  const cancelAgentRuns = useTab((state) => state.cancelAgentRuns);
  const now = useNow();
  if (!run) return null;

  const quiet = now - (run.lastOutputAt ?? run.startedAt);
  const silent = quiet >= QUIET_NOTICE_MS;
  return (
    <div className={cx(css.progress, className)}>
      <span className={css.clock}>{clock(now - run.startedAt)}</span>
      <span className={silent ? css.silent : undefined}>
        {silent
          ? `No output for ${Math.floor(quiet / 60_000)} min. ${agent} may be waiting on the network; it is stopped after ${QUIET_LIMIT_MINUTES} min of silence.`
          : run.lastOutputAt === null
            ? "starting…"
            : `last output ${ago(quiet)}`}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => cancelAgentRuns(cancels)}
        disabled={run.cancelling}
      >
        {run.cancelling ? "Cancelling…" : "Cancel"}
      </Button>
    </div>
  );
}

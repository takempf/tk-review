import { useEffect, useState } from "react";
import { type EngineModels, gitApi, type ReviewEngine } from "../ipc/git";
import { ENGINE_LABELS } from "./engines";

export type Catalogs = Partial<Record<ReviewEngine, EngineModels>>;

/** Read once per app load; every reader shares the one read. */
let catalogsPromise: Promise<Catalogs> | null = null;
/** The read's result once it lands, so later readers start with it. */
let loadedCatalogs: Catalogs | null = null;

function loadCatalogs(): Promise<Catalogs> {
  catalogsPromise ??= Promise.all(
    (Object.keys(ENGINE_LABELS) as ReviewEngine[]).map(async (engine) => {
      // A failed read is the same as no cache: callers fall back to their own.
      const catalog = await gitApi.listAgentModels(engine).catch(() => null);
      return [engine, catalog] as const;
    }),
  ).then((entries) => {
    const catalogs: Catalogs = {};
    for (const [engine, catalog] of entries) if (catalog) catalogs[engine] = catalog;
    loadedCatalogs = catalogs;
    return catalogs;
  });
  return catalogsPromise;
}

/**
 * The model catalogs each engine's CLI has cached on disk: what it last
 * fetched from the service, so the app keeps pace with the installed CLI
 * rather than with this app's release. Empty until the read lands, and for an
 * engine with no cache.
 */
export function useModelCatalogs(): Catalogs {
  const [catalogs, setCatalogs] = useState<Catalogs>(() => loadedCatalogs ?? {});
  useEffect(() => {
    if (loadedCatalogs) return;
    let cancelled = false;
    void loadCatalogs().then((loaded) => {
      if (!cancelled) setCatalogs(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return catalogs;
}

/** `claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-5`. */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
/** The older order, version first: `claude-3-5-sonnet-20241022`. */
const CLAUDE_LEGACY_ID = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/;
/** Claude Code's suffix for the 1M-token context window: `opus[1m]`. */
const LONG_CONTEXT = /\[1m\]$/i;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function version(major: string, minor: string | undefined): string {
  return minor ? `${major}.${minor}` : major;
}

/**
 * A readable name for a model id the catalog doesn't know, spelled the way the
 * catalogs spell theirs: `claude-opus-5-5` is "Opus 5.5", `opus` is "Opus",
 * and codex's `gpt-5.6-terra` is "GPT-5.6-Terra". An id in no shape it knows
 * comes back as it is.
 */
export function parseModelLabel(id: string): string {
  const trimmed = id.trim();
  const long = LONG_CONTEXT.test(trimmed);
  const bare = trimmed.replace(LONG_CONTEXT, "");
  const suffix = long ? " (1M context)" : "";

  const claude = CLAUDE_ID.exec(bare);
  if (claude) {
    const [, family = "", major = "", minor] = claude;
    return `${capitalize(family)} ${version(major, minor)}${suffix}`;
  }
  const legacy = CLAUDE_LEGACY_ID.exec(bare);
  if (legacy) {
    const [, major = "", minor, family = ""] = legacy;
    return `${capitalize(family)} ${version(major, minor)}${suffix}`;
  }

  // Aliases and codex slugs: words capitalised, "gpt" as an initialism, and
  // anything with a digit in it (`5.6`, `o3`) left alone.
  const words = bare
    .split("-")
    .map((part) => (part === "gpt" ? "GPT" : /^[a-z]+$/.test(part) ? capitalize(part) : part));
  return `${words.join("-")}${suffix}`;
}

/** The catalog's name for `id` when it lists one, or one parsed from the id. */
export function modelLabel(id: string, catalog: EngineModels | undefined): string {
  return catalog?.models.find((model) => model.id === id.trim())?.label ?? parseModelLabel(id);
}

/** `id`'s readable name for `engine`, or `null` for no model (the CLI's default). */
export function useModelLabel(engine: ReviewEngine, id: string | null | undefined): string | null {
  const catalogs = useModelCatalogs();
  return id?.trim() ? modelLabel(id, catalogs[engine]) : null;
}

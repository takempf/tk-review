import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type ReactNode, useEffect, useState } from "react";
import { Icon, Logo, Menu, SceneryWindow } from "tk-design-system";
import { chooseFolder } from "../../lib/chooseFolder";
import { useAppStore } from "../../store/appStore";
import { type RecentRepo, readRecentRepos } from "../../store/history";
import { Spinner } from "../Spinner/Spinner";
import css from "./TitleBar.module.css";

/**
 * On macOS the window's title bar is an overlay (see `tauri.conf.json`), so the
 * traffic lights sit on top of this bar. Elsewhere the native frame stays.
 */
const OVERLAID = isTauri() && navigator.userAgent.includes("Mac OS X");

/** macOS hides the traffic lights in full screen, and the bar gets that room back. */
function useTrafficLightInset(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!OVERLAID) return;
    const window = getCurrentWindow();
    const sync = () =>
      void window
        .isFullscreen()
        .then(setFullscreen)
        .catch(() => {});
    sync();

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // Entering and leaving full screen both resize the window.
    void window
      .onResized(sync)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return OVERLAID && !fullscreen;
}

const shortPath = (root: string) => root.replace(/^\/Users\/[^/]+/, "~");

function RepoSelect() {
  const repo = useAppStore((state) => state.repo);
  const loading = useAppStore((state) => state.loadingRepo);
  const openRepo = useAppStore((state) => state.openRepo);
  // A small localStorage read; opening a repository re-renders this and reorders it.
  const recent: RecentRepo[] = readRecentRepos();
  const listed =
    repo && !recent.some((entry) => entry.root === repo.root)
      ? [{ root: repo.root, name: repo.name, openedAt: "" }, ...recent]
      : recent;

  async function add() {
    const path = await chooseFolder();
    if (path) await openRepo(path);
  }

  return (
    <Menu.Root>
      <Menu.Trigger className={css.trigger} title={repo ? repo.root : undefined}>
        <span className={css.value} data-placeholder={repo ? undefined : ""}>
          {repo?.name ?? (loading ? "Opening…" : "Open a repository")}
        </span>
        <span className={css.icon}>{loading ? <Spinner /> : <Icon name="chevron-updown" />}</span>
      </Menu.Trigger>
      <Menu.Popup className={css.popup}>
        {listed.length > 0 ? (
          <>
            <Menu.RadioGroup
              value={repo?.root ?? null}
              onValueChange={(root: string) => {
                if (root !== repo?.root) void openRepo(root);
              }}
            >
              {listed.map((entry) => (
                <Menu.RadioItem
                  key={entry.root}
                  value={entry.root}
                  closeOnClick
                  disabled={loading}
                  title={entry.root}
                >
                  <span className={css.repoName}>{entry.name}</span>
                  <span className={css.repoPath}>{shortPath(entry.root)}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator />
          </>
        ) : null}
        <Menu.Item icon="plus" onClick={() => void add()} disabled={loading}>
          Add repository…
        </Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );
}

/**
 * The window's top bar, drawn by the app rather than the OS, the way VS Code's
 * or Discord's is: the app's name and the repository switcher, centred as a
 * native window title would be, with the empty space dragging the window.
 * `children` is a second row under it (the tab bar), on the same backdrop.
 *
 * The backdrop is the theme's scene, the one the welcome screen's hero shows,
 * framed in the bar itself: the viewport-pinned default would give it only the
 * top 40px of the illustration, which is sky.
 */
export function TitleBar({ children }: { children?: ReactNode }) {
  const inset = useTrafficLightInset();

  return (
    <header className={css.chrome} data-tauri-drag-region="deep">
      <SceneryWindow attachment="local" className={css.scenery} />
      <div className={css.bar} data-inset={inset || undefined}>
        <span className={css.brand}>
          <Logo className={css.mark} />
          Review
        </span>
        <span className={css.divider} />
        <RepoSelect />
      </div>
      {children}
    </header>
  );
}

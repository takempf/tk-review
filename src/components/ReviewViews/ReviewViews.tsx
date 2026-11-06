import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon, Tabs } from "tk-design-system";
import { useTab } from "../../store/tabStore";
import { Codemap, type FileFocus } from "../Codemap/Codemap";
import css from "./ReviewViews.module.css";

type View = "diff" | "codemap";

/** The diff and the codemap, one at a time, in the middle of the review. */
export function ReviewViews({ diff }: { diff: ReactNode }) {
  const [view, setView] = useState<View>("diff");
  const selectFile = useTab((state) => state.selectFile);
  const changedPaths = useTab((state) => state.summary?.files);

  // While the codemap shows, choosing a file shows where it sits there; the diff scrolls to it on its own.
  const selectedPath = useTab((state) => state.selectedPath);
  const selectionTick = useTab((state) => state.selectionTick);
  const seenTick = useRef(selectionTick);
  const [focus, setFocus] = useState<FileFocus | null>(null);
  useEffect(() => {
    if (selectionTick === seenTick.current) return;
    seenTick.current = selectionTick;
    if (view === "codemap" && selectedPath) setFocus({ path: selectedPath, tick: selectionTick });
  }, [selectionTick, selectedPath, view]);

  const showFile = useCallback(
    (path: string) => {
      if (!changedPaths?.some((file) => file.path === path)) return;
      setView("diff");
      selectFile(path);
    },
    [changedPaths, selectFile],
  );

  return (
    <Tabs.Root className={css.views} value={view} onValueChange={(next) => setView(next as View)}>
      <div className={css.tabBar}>
        <Tabs.List className={css.tabList} aria-label="Review views">
          <Tabs.Tab value="diff">
            <Icon name="rows" /> Diff
          </Tabs.Tab>
          <Tabs.Tab value="codemap">
            <Icon name="quartered-square" /> Codemap
          </Tabs.Tab>
        </Tabs.List>
      </div>
      <div className={css.stack}>
        <Tabs.Panel value="diff" keepMounted className={css.view} inert={view !== "diff"}>
          {diff}
        </Tabs.Panel>
        <Tabs.Panel value="codemap" keepMounted className={css.view} inert={view !== "codemap"}>
          <Codemap shown={view === "codemap"} focus={focus} onShowFile={showFile} />
        </Tabs.Panel>
      </div>
    </Tabs.Root>
  );
}

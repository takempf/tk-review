import { Tooltip } from "tk-design-system";
import { ScreenMorph } from "../../lib/screenTransition";
import { useAppStore } from "../../store/appStore";
import { useTab, useTabHandle } from "../../store/tabStore";
import { githubHost } from "../Author/Author";
import { PrBranches } from "../PrBranches/PrBranches";
import css from "./PrHeading.module.css";

// GitHub's mark, from Primer Octicons (`mark-github`, 16px).
const GITHUB_MARK =
  "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z";

/** Its number and title glide here from the PR's list row or tab, and back to its tab on leaving. */
export function PrHeading() {
  // While it opens, the list's number, title, author and branches stand in for the fetched ones.
  const pr = useTab((state) => state.pr ?? state.pendingPr);
  const { morphKey } = useTabHandle();
  const carried = useAppStore((state) => {
    const change = state.screenChange;
    return change != null && (change.carrying === morphKey || change.trading.includes(morphKey));
  });
  if (!pr) return null;

  return (
    <>
      <Tooltip content="Open on GitHub">
        <a className={css.name} href={pr.url} target="_blank" rel="noreferrer">
          <svg
            className={`tk-icon ${css.mark}`}
            viewBox="0 0 16 16"
            width="1em"
            height="1em"
            aria-hidden="true"
          >
            <path className="tk-icon-fill" d={GITHUB_MARK} />
          </svg>
          <ScreenMorph id={morphKey} part="number" active={carried}>
            <span className={css.number}>#{pr.number}</span>
          </ScreenMorph>{" "}
          <ScreenMorph id={morphKey} part="title" active={carried}>
            <span className={css.title}>{pr.title}</span>
          </ScreenMorph>
        </a>
      </Tooltip>
      {pr.headRef && pr.baseRef ? (
        <PrBranches
          author={pr.author ?? null}
          host={githubHost(pr.url)}
          headRef={pr.headRef}
          baseRef={pr.baseRef}
        />
      ) : null}
    </>
  );
}

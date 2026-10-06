import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Badge,
  Button,
  Dialog,
  Icon,
  type IconName,
  Input,
  Kbd,
  Separator,
  Stack,
  Toggle,
  ToggleGroup,
  Tooltip,
} from "tk-design-system";
import { useScreenShown } from "../../lib/screenTransition";
import { highlightSearch } from "../../lib/searchHighlight";
import {
  matchExcerpt,
  RESULT_LIMIT,
  type SearchDocument,
  type SearchMatch,
  type SearchOptions,
  type SearchScope,
  searchDocuments,
} from "../../lib/textSearch";
import css from "./Search.module.css";

export interface SearchReveal {
  document: SearchDocument;
  query: string;
  options: SearchOptions;
  tick: number;
}

const SCOPES: { value: SearchScope | "all"; label: string; icon: IconName }[] = [
  { value: "all", label: "Everything", icon: "search" },
  { value: "files", label: "Files", icon: "folder" },
  { value: "diff", label: "Diff", icon: "rows" },
  { value: "conversations", label: "Conversations", icon: "comment" },
  { value: "commits", label: "Commits", icon: "branch" },
  { value: "pullRequests", label: "Pull requests", icon: "pull-request" },
];

interface SearchContextValue {
  openSearch: () => void;
  setDocuments: (documents: SearchDocument[]) => void;
  reveal: SearchReveal | null;
}

const SearchContext = createContext<SearchContextValue | null>(null);
export function useSearch() {
  const value = useContext(SearchContext);
  if (!value) throw new Error("Search requires SearchProvider");
  return value;
}

export function useSearchDocuments(documents: SearchDocument[]) {
  const { setDocuments } = useSearch();
  useEffect(() => {
    setDocuments(documents);
    return () => setDocuments([]);
  }, [documents, setDocuments]);
}

/** Reveals a result after its panel and any containing sections have opened. */
export function useSearchReveal(ref: RefObject<HTMLElement | null>) {
  const { reveal } = useSearch();
  useEffect(() => {
    if (!reveal) return;
    const target = reveal.document.target;
    if (!target) {
      if (reveal.document.scope !== "diff") return;
      const frame = requestAnimationFrame(() =>
        ref.current
          ?.querySelector<HTMLElement>('[data-panel="diff"]')
          ?.focus({ preventScroll: true }),
      );
      return () => cancelAnimationFrame(frame);
    }
    let animation: Animation | undefined;
    let clearHighlight = () => {};
    let frame = 0;
    let attempts = 0;
    const find = () => {
      const element = [
        ...(ref.current?.querySelectorAll<HTMLElement>("[data-search-id]") ?? []),
      ].find(
        (node) =>
          node.dataset.searchId === target &&
          node.getClientRects().length > 0 &&
          !node.closest("[inert]") &&
          getComputedStyle(node).visibility === "visible",
      );
      if (!element) {
        if (++attempts < 30) frame = requestAnimationFrame(find);
        return;
      }
      element.scrollIntoView({ block: "center", behavior: "instant" });
      element.focus({ preventScroll: true });
      // WebKit can release a hidden panel's focusability a frame after its layout.
      if (document.activeElement !== element && ++attempts < 30) {
        frame = requestAnimationFrame(find);
        return;
      }
      clearHighlight = highlightSearch(element, reveal.query, reveal.options);
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        animation = element.animate(
          [
            { backgroundColor: "color-mix(in oklab, var(--accent) 18%, transparent)" },
            { backgroundColor: "transparent" },
          ],
          { duration: 1500, easing: "ease-out" },
        );
      }
    };
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(find);
    });
    return () => {
      cancelAnimationFrame(frame);
      animation?.cancel();
      clearHighlight();
    };
  }, [ref, reveal]);
}

export function SearchButton({ id }: { id: string }) {
  return (
    <Tooltip content="Search this view (⌘F)" side="bottom">
      <Dialog.Trigger
        id={id}
        render={<Button variant="ghost" size="sm" />}
        aria-label="Search this view"
      >
        <Dialog.SharedElement name="search" side="trigger">
          <Icon name="search" />
        </Dialog.SharedElement>
        <Kbd>⌘F</Kbd>
      </Dialog.Trigger>
    </Tooltip>
  );
}

export function SearchProvider({
  children,
  actionContainer,
}: {
  children: ReactNode;
  actionContainer?: HTMLElement | null;
}) {
  const shown = useScreenShown();
  const [documents, setDocuments] = useState<SearchDocument[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope | "all">("all");
  const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false });
  const [active, setActive] = useState(0);
  const [reveal, setReveal] = useState<SearchReveal | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialogActions = useRef<{ close: () => void; unmount: () => void } | null>(null);
  const results = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigating = useRef(false);
  const navigation = useRef<{ match: SearchMatch; query: string; options: SearchOptions } | null>(
    null,
  );
  const listId = useId();
  const triggerId = useId();
  const deferredQuery = useDeferredValue(query);
  const pending = query !== deferredQuery;
  const search = useMemo(
    () => searchDocuments(documents, deferredQuery, scope, options),
    [documents, deferredQuery, scope, options],
  );
  const index = Math.min(active, Math.max(0, search.matches.length - 1));
  const available = SCOPES.filter(
    ({ value }) => value === "all" || documents.some((doc) => doc.scope === value),
  );

  const openSearch = useCallback(() => {
    document.getElementById(triggerId)?.click();
  }, [triggerId]);

  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    navigating.current = false;
    navigation.current = null;
    setScope("all");
    setActive(0);
    requestAnimationFrame(() => input.current?.select());
  }, []);

  useEffect(() => {
    if (!shown) {
      if (open) dialogActions.current?.close();
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (open) input.current?.select();
        else openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, open, openSearch]);

  useEffect(() => {
    results.current
      ?.querySelector(`[data-result-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function choose(match: SearchMatch) {
    navigating.current = true;
    navigation.current = { match, query, options };
    dialogActions.current?.close();
  }

  function finishNavigation(isOpen: boolean) {
    if (isOpen || !navigation.current) return;
    const { match, query: needle, options: matching } = navigation.current;
    navigation.current = null;
    setReveal((previous) => ({
      document: match.document,
      query: needle,
      options: matching,
      tick: (previous?.tick ?? 0) + 1,
    }));
    match.document.activate?.();
  }

  const context = useMemo(() => ({ openSearch, setDocuments, reveal }), [openSearch, reveal]);

  return (
    <SearchContext value={context}>
      {children}
      <Dialog.Root
        transition="shared"
        actionsRef={dialogActions}
        triggerId={triggerId}
        onOpenChange={changeOpen}
        onOpenChangeComplete={finishNavigation}
      >
        {shown && actionContainer
          ? createPortal(<SearchButton id={triggerId} />, actionContainer)
          : null}
        <Dialog.Popup
          size="lg"
          className={css.popup}
          aria-label="Find in this view"
          initialFocus={input}
          finalFocus={() => (navigating.current ? false : returnFocus.current)}
        >
          <Stack direction="row" align="center" gap={3}>
            <Dialog.SharedElement name="search" side="popup">
              <Icon name="search" className={css.searchIcon} />
            </Dialog.SharedElement>
            <Dialog.Content className={css.searchField}>
              <Input
                ref={input}
                size="lg"
                value={query}
                placeholder="Find anything in this view…"
                aria-label="Search text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={search.matches.length > 0}
                aria-controls={listId}
                aria-activedescendant={search.matches.length ? `${listId}-${index}` : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const count = search.matches.length;
                    if (count)
                      setActive((index + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
                  } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    const current = pending
                      ? searchDocuments(documents, query, scope, options).matches
                      : search.matches;
                    const match = current[Math.min(index, Math.max(0, current.length - 1))];
                    if (match) choose(match);
                  }
                }}
              />
              {query ? (
                <Button
                  variant="ghost"
                  size="sm"
                  square
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    setActive(0);
                    input.current?.focus();
                  }}
                >
                  <Icon name="close" />
                </Button>
              ) : null}
              <Dialog.Close
                render={<Button variant="ghost" size="sm" square aria-label="Close search" />}
              >
                <Icon name="close" />
              </Dialog.Close>
            </Dialog.Content>
          </Stack>
          <Dialog.Content>
            <Stack direction="row" align="center" justify="between" gap={3} wrap>
              <div className={css.scopeViewport}>
                <ToggleGroup
                  size="sm"
                  aria-label="Search in"
                  value={[scope]}
                  onValueChange={(values) => {
                    const next = available.find(({ value }) => value === values[0]);
                    if (next) {
                      setScope(next.value);
                      setActive(0);
                    }
                  }}
                >
                  {available.map(({ value, label }) => (
                    <Toggle key={value} value={value} onClick={() => input.current?.focus()}>
                      {label}
                      {query && search.counts[value] > 0 ? (
                        <Badge className={css.scopeCount}>{search.counts[value]}</Badge>
                      ) : null}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
              <ToggleGroup
                size="sm"
                multiple
                aria-label="Search options"
                value={[
                  ...(options.caseSensitive ? ["case"] : []),
                  ...(options.wholeWord ? ["word"] : []),
                ]}
                onValueChange={(values) => {
                  setOptions({
                    caseSensitive: values.includes("case"),
                    wholeWord: values.includes("word"),
                  });
                  setActive(0);
                }}
              >
                <Tooltip content="Match case">
                  <Toggle value="case" aria-label="Match case">
                    Aa
                  </Toggle>
                </Tooltip>
                <Tooltip content="Whole word">
                  <Toggle value="word" className={css.wholeWord} aria-label="Whole word">
                    ab
                  </Toggle>
                </Tooltip>
              </ToggleGroup>
            </Stack>
            <Separator />
            <div
              ref={results}
              id={listId}
              role="listbox"
              aria-label="Search results"
              aria-busy={pending}
              className={css.results}
              data-pending={pending || undefined}
            >
              {search.matches.map((match, resultIndex) => {
                const excerpt = matchExcerpt(match);
                const meta = SCOPES.find((entry) => entry.value === match.document.scope);
                return (
                  <Button
                    key={match.id}
                    variant={resultIndex === index ? "primary" : "ghost"}
                    role="option"
                    id={`${listId}-${resultIndex}`}
                    className={css.result}
                    aria-selected={resultIndex === index}
                    data-result-index={resultIndex}
                    tabIndex={-1}
                    onPointerMove={() => setActive(resultIndex)}
                    onClick={() => {
                      if (!pending) choose(match);
                    }}
                  >
                    <span className={css.resultIcon}>
                      <Icon name={meta?.icon ?? "search"} />
                    </span>
                    <span className={css.resultBody}>
                      <span className={css.resultHeading}>
                        <span>{match.document.title}</span>
                        <small>{match.document.detail ?? meta?.label}</small>
                      </span>
                      <span className={css.excerpt}>
                        {excerpt.before.replace(/\s+/g, " ")}
                        <mark>{excerpt.match}</mark>
                        {excerpt.after.replace(/\s+/g, " ")}
                      </span>
                    </span>
                    <span className={css.enter}>↵</span>
                  </Button>
                );
              })}
              {!search.matches.length ? (
                <Stack className={css.empty} align="center" justify="center" gap={2}>
                  <span className={css.emptyIcon}>
                    <Icon name="search" />
                  </span>
                  <p>
                    {query ? "No matches found" : "A little less looking. A little more finding."}
                  </p>
                  <span>
                    {query
                      ? "Try another phrase or a broader scope."
                      : "Search the whole view, or narrow it to a panel above."}
                  </span>
                </Stack>
              ) : null}
            </div>
            <Separator />
            <footer className={css.footer}>
              <span role="status" aria-live="polite">
                {pending
                  ? "Searching…"
                  : !query
                    ? "Literal text search"
                    : `${search.total.toLocaleString()} ${search.total === 1 ? "match" : "matches"}${search.total > RESULT_LIMIT ? ` · showing first ${RESULT_LIMIT}` : ""}`}
              </span>
              <span className={css.hints}>
                <span>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> navigate
                </span>
                <span>
                  <Kbd>↵</Kbd> jump
                </span>
                <span>
                  <Kbd>esc</Kbd> close
                </span>
              </span>
            </footer>
          </Dialog.Content>
        </Dialog.Popup>
      </Dialog.Root>
    </SearchContext>
  );
}

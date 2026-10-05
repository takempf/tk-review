import { useState } from "react";
import { cx } from "tk-design-system";
import css from "./Author.module.css";

/**
 * The account `login` names, bare: GitHub spells a bot `app/name` or
 * `name[bot]` depending on the endpoint, and keeps its picture under `name`.
 */
function accountName(login: string): string {
  return login.replace(/^app\//, "").replace(/\[bot\]$/, "");
}

/** Where `host` serves `name`'s avatar, at twice its size here for a Retina screen. */
function avatarUrl(name: string, host: string): string {
  return `https://${host}/${encodeURIComponent(name)}.png?size=64`;
}

/**
 * The GitHub host a PR's `url` is on, for its people's avatars. A login names
 * different people on github.com and on an Enterprise host.
 */
export function githubHost(url: string | null | undefined): string {
  if (!url) return "github.com";
  try {
    return new URL(url).host;
  } catch {
    return "github.com";
  }
}

/**
 * A GitHub account as the app shows one: its avatar, then its login. The
 * login's first letter holds the avatar's place until it loads, and keeps it
 * if it can't (an Enterprise host that wants signing in, say).
 */
export function Author({
  login,
  host,
  className,
}: {
  login: string;
  host: string;
  className?: string;
}) {
  const name = accountName(login);
  const src = avatarUrl(name, host);
  // Keyed by the URL, so a different account gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={cx(css.author, className)}>
      <span className={css.avatar} aria-hidden="true">
        {name.charAt(0).toUpperCase()}
        {failed === src ? null : (
          <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(src)} />
        )}
      </span>
      <span className={css.login}>{login}</span>
    </span>
  );
}

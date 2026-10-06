import { useLayoutEffect, useRef } from "react";
import { cx } from "tk-design-system";
import { useAvatar } from "../../lib/avatars";
import css from "./Author.module.css";

/**
 * The account `login` names, bare: GitHub spells a bot `app/name` or
 * `name[bot]` depending on the endpoint, and keeps its picture under `name`.
 */
function accountName(login: string): string {
  return login.replace(/^app\//, "").replace(/\[bot\]$/, "");
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
  const image = useAvatar(name, host);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    // Paint the shared decoded image before this byline's first frame. An img
    // with the same URL would still go through the browser's loading path.
    const context = canvas.current?.getContext("2d");
    if (image && context) {
      context.clearRect(0, 0, 64, 64);
      context.drawImage(image, 0, 0, 64, 64);
    }
  }, [image]);
  return (
    <span className={cx(css.author, className)}>
      <span className={css.avatar} aria-hidden="true">
        {name.charAt(0).toUpperCase()}
        {image ? <canvas ref={canvas} width={64} height={64} /> : null}
      </span>
      <span className={css.login}>{login}</span>
    </span>
  );
}

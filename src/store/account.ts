import type { RepoInfo } from "../ipc/git";
import { moveReviewHistory } from "./history";

/**
 * Stored reviews, explanations, viewed files and the review history belong to
 * whoever `gh` is signed in as on the repository's GitHub host, so two accounts
 * on one computer never see each other's. Their keys carry the login after the
 * repository's path. A repository with no account (no GitHub remote, or no
 * `gh` login) keeps the bare path.
 */
export function storageRoot(repo: Pick<RepoInfo, "root" | "githubLogin">): string {
  return repo.githubLogin ? `${repo.root}@${repo.githubLogin}` : repo.root;
}

/** Whether `author` is the signed-in account. GitHub logins ignore case. */
export function isSignedInAs(repo: Pick<RepoInfo, "githubLogin">, author: string): boolean {
  return repo.githubLogin?.toLowerCase() === author.toLowerCase();
}

/** Every key whose name starts with the repository's storage root. */
const SCOPED_PREFIXES = ["tk-review:reviews:", "tk-review:explanations:", "tk-review:viewed:"];

/**
 * Hands what is stored under the bare path to the signed-in account: everything
 * from before accounts were told apart, and anything written while `gh` was
 * signed out. Whoever opens the repository signed in first gets it. A key the
 * account already has keeps its own value, and the unscoped one stays put
 * rather than being thrown away.
 */
export function claimUnscopedStorage(repo: Pick<RepoInfo, "root" | "githubLogin">): void {
  if (!repo.githubLogin) return;
  const scoped = storageRoot(repo);
  try {
    for (const key of Object.keys(localStorage)) {
      for (const prefix of SCOPED_PREFIXES) {
        const from = `${prefix}${repo.root}:`;
        if (!key.startsWith(from)) continue;
        const to = `${prefix}${scoped}:${key.slice(from.length)}`;
        const value = localStorage.getItem(key);
        if (value === null || localStorage.getItem(to) !== null) continue;
        localStorage.setItem(to, value);
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Unavailable storage has nothing to claim.
  }
  moveReviewHistory(repo.root, scoped);
}

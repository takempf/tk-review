import { open } from "@tauri-apps/plugin-dialog";

/** The native folder picker, for opening a repository. `null` when cancelled. */
export async function chooseFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a git repository",
  });
  return typeof selected === "string" ? selected : null;
}

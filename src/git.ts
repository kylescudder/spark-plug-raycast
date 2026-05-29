import { execFileSync } from "child_process";
import { existsSync, lstatSync, rmSync } from "fs";
import { join } from "path";

const GIT = "/usr/bin/git";

function git(args: string[]): string {
  return execFileSync(GIT, args, { encoding: "utf-8" }).trim();
}

/**
 * Permanently removes a worktree. For a real git worktree (.git is a pointer
 * *file*) this runs `git worktree remove --force` so the main repo's metadata
 * is cleaned up too; for a plain folder it deletes the directory outright.
 * Throws on failure. Claude transcripts under ~/.claude are left intact.
 */
export function removeWorktree(worktreePath: string): void {
  const gitMeta = join(worktreePath, ".git");
  const isLinkedWorktree = existsSync(gitMeta) && lstatSync(gitMeta).isFile();

  if (isLinkedWorktree) {
    // git refuses to remove the worktree containing its own cwd, so resolve
    // the main working tree and run the command from there.
    const commonDir = git([
      "-C",
      worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]); // …/.git
    const mainTree = join(commonDir, ".."); // parent of .git
    git(["-C", mainTree, "worktree", "remove", "--force", worktreePath]);
    git(["-C", mainTree, "worktree", "prune"]);
  } else {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

// End-to-end checks for everything Spark Plug does outside Raycast's UI:
// reading real Claude transcripts, removing real git worktrees, and the exact
// shell command handed to Terminal (executed here with stub `claude`/`clear`).
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const scripts: string[] = [];
mock.module("@raycast/utils", () => ({
  runAppleScript: async (script: string) => {
    scripts.push(script);
    return "";
  },
}));

// `bun run test:e2e` starts Bun with HOME pointing at a throwaway directory; never
// let this suite read or write the real ~/.claude.
const home = homedir();
if (
  !process.env.SPARK_PLUG_E2E_HOME ||
  process.env.SPARK_PLUG_E2E_HOME !== home
) {
  throw new Error(
    "Run via `bun run test:e2e` so HOME is a disposable directory.",
  );
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "spark-plug-e2e-")));

const { encodePath, liveSessionIds, readSessions, sessionLabel } =
  await import("../src/claude-sessions");
const { removeWorktree } = await import("../src/git");
const { createWorktree, launchClaude } = await import("../src/launch");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("Claude sessions for a worktree", () => {
  const worktree = join(root, "worktrees", "MP-42_fix.login");
  const projectDir = join(home, ".claude", "projects", encodePath(worktree));

  beforeAll(() => {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    const lines = (...objects: unknown[]) =>
      objects
        .map((o) => (typeof o === "string" ? o : JSON.stringify(o)))
        .join("\n");
    writeFileSync(
      join(projectDir, "older-session.jsonl"),
      lines(
        {
          type: "user",
          isSidechain: true,
          message: { content: "subagent noise" },
        },
        "{not json",
        {
          type: "user",
          message: {
            content: [{ type: "text", text: "  Fix   the\nlogin redirect " }],
          },
        },
      ),
    );
    writeFileSync(
      join(projectDir, "titled-session.jsonl"),
      lines(
        { type: "user", message: { content: "first prompt" } },
        { type: "custom-title", customTitle: "Login fix" },
      ),
    );
    writeFileSync(join(projectDir, "notes.txt"), "ignored");
    const hourAgo = Date.now() / 1000 - 3600;
    utimesSync(join(projectDir, "older-session.jsonl"), hourAgo, hourAgo);
    writeFileSync(
      join(home, ".claude", "sessions", "1.json"),
      JSON.stringify({ sessionId: "titled-session" }),
    );
    writeFileSync(join(home, ".claude", "sessions", "broken.json"), "{");
  });

  test("lists transcripts newest first with titles, first prompts and live state", () => {
    const sessions = readSessions(worktree, liveSessionIds());
    expect(sessions.map((s) => s.id)).toEqual([
      "titled-session",
      "older-session",
    ]);
    expect(sessionLabel(sessions[0]!)).toBe("● live · Login fix · just now");
    expect(sessionLabel(sessions[1]!)).toBe("Fix the login redirect · 1h");
  });

  test("a worktree with no transcripts has no sessions", () => {
    expect(readSessions(join(root, "worktrees", "fresh"), new Set())).toEqual(
      [],
    );
  });
});

describe("removing worktrees", () => {
  test("a linked git worktree is removed and pruned from the main repo", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(
      repo,
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@example.test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const linked = join(root, "worktrees", "MP-7");
    git(repo, "worktree", "add", "-q", "-b", "MP-7", linked);
    writeFileSync(join(linked, "dirty.txt"), "uncommitted");

    removeWorktree(linked);

    expect(existsSync(linked)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(linked);
    expect(git(repo, "branch", "--list", "MP-7")).toContain("MP-7");
  });

  test("a plain folder is deleted", () => {
    const folder = join(root, "worktrees", "scratch");
    mkdirSync(join(folder, "nested"), { recursive: true });
    removeWorktree(folder);
    expect(existsSync(folder)).toBe(false);
  });
});

describe("Terminal commands", () => {
  const bin = join(root, "bin");
  const record = join(root, "claude-invocations.log");

  beforeAll(() => {
    mkdirSync(bin);
    writeFileSync(join(bin, "clear"), "#!/bin/sh\n");
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\n{ pwd; for a in "$@"; do printf '[%s]' "$a"; done; echo; } >> '${record}'\n`,
    );
    chmodSync(join(bin, "clear"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
  });

  // Recover the shell command from the AppleScript exactly as Terminal would receive it.
  const runLastScript = () => {
    const script = scripts.at(-1)!;
    const quoted = /do script "((?:\\.|[^"\\])*)"/.exec(script)![1]!;
    const command = quoted.replace(/\\(["\\])/g, "$1");
    rmSync(record, { force: true });
    execFileSync("/bin/sh", ["-c", command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return readFileSync(record, "utf-8").trim().split("\n");
  };

  test("resuming a session opens Claude in the worktree, safely quoted", async () => {
    const tricky = join(root, "worktrees", `it's "quoted" $(touch pwned)`);
    mkdirSync(tricky, { recursive: true });
    await launchClaude(tricky, { resumeSessionId: "abc-123" });
    expect(runLastScript()).toEqual([tricky, "[--resume][abc-123]"]);
    expect(existsSync(join(tricky, "pwned"))).toBe(false);
  });

  test("a new named session passes the name as one argument", async () => {
    const worktree = join(root, "worktrees", "named");
    mkdirSync(worktree, { recursive: true });
    await launchClaude(worktree, { newSessionName: "Fix 'login' & tidy" });
    expect(runLastScript()).toEqual([worktree, "[-n][Fix 'login' & tidy]"]);
  });

  test("creating a worktree runs the setup template in the source repo, then Claude in the new worktree", async () => {
    const source = join(root, "source");
    const created = join(root, "worktrees", "MP-99");
    mkdirSync(source);
    writeFileSync(
      join(source, "setup.sh"),
      `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$2" "$3" > '${join(root, "setup-args")}'\nmkdir -p '${created}'\n`,
    );
    chmodSync(join(source, "setup.sh"), 0o755);

    await createWorktree({
      sourceRepo: source,
      worktreePath: created,
      ticket: "MP-99",
      briefName: "fix; rm -rf ~",
      baseBranch: "main",
      setupCommandTemplate: "./setup.sh {ticket} {brief} {base}",
    });

    expect(runLastScript()).toEqual([created]);
    expect(readFileSync(join(root, "setup-args"), "utf-8")).toBe(
      "MP-99|fix; rm -rf ~|main",
    );
  });
});

import { runAppleScript } from "@raycast/utils";

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function launchClaude(
  worktreePath: string,
  opts: { resumeSessionId?: string; newSessionName?: string } = {},
): Promise<void> {
  let claudeCmd = "claude";
  if (opts.resumeSessionId) {
    claudeCmd += ` --resume ${shellQuote(opts.resumeSessionId)}`;
  } else if (opts.newSessionName) {
    claudeCmd += ` -n ${shellQuote(opts.newSessionName)}`;
  }

  const fullCommand = `cd ${shellQuote(worktreePath)} && clear && ${claudeCmd}`;
  await runInTerminal(fullCommand);
}

/**
 * Creates a worktree by running the setup command in `sourceRepo`, then
 * launches Claude *inside* the new worktree so its transcript is associated
 * with the worktree (not the source repo). All chained in one Terminal window.
 */
export async function createWorktree(opts: {
  sourceRepo: string;
  worktreePath: string;
  ticket: string;
  briefName: string;
  baseBranch: string;
  setupCommandTemplate: string;
}): Promise<void> {
  const setupCmd = opts.setupCommandTemplate
    .replace(/\{ticket\}/g, () => shellQuote(opts.ticket))
    .replace(/\{brief\}/g, () => shellQuote(opts.briefName))
    .replace(/\{base\}/g, () => shellQuote(opts.baseBranch));
  const fullCommand =
    `cd ${shellQuote(opts.sourceRepo)} && ${setupCmd} ` +
    `&& cd ${shellQuote(opts.worktreePath)} && clear && claude`;
  await runInTerminal(fullCommand);
}

async function runInTerminal(command: string): Promise<void> {
  const script = `
    tell application "Terminal"
      activate
      do script "${appleScriptEscape(command)}"
    end tell
  `;
  await runAppleScript(script);
}

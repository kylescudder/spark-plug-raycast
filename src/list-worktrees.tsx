import {
  Action,
  ActionPanel,
  Alert,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  getPreferenceValues,
  showToast,
  useNavigation,
} from "@raycast/api";
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClaudeSession,
  liveSessionIds,
  readSessions,
  relativeShort,
  sessionDir,
  sessionLabel,
  sessionTitle,
} from "./claude-sessions";
import { createWorktree, launchClaude } from "./launch";
import { removeWorktree } from "./git";

interface Preferences {
  worktreesRoot: string;
  sourceRepo: string;
  setupCommandTemplate: string;
}

interface Worktree {
  name: string;
  path: string;
  isGitRepo: boolean;
  sessions: ClaudeSession[];
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function loadWorktrees(root: string): { trees: Worktree[]; error?: string } {
  const expanded = expandHome(root.trim());
  if (!existsSync(expanded)) {
    return { trees: [], error: `Folder not found: ${expanded}` };
  }
  let stat;
  try {
    stat = statSync(expanded);
  } catch (e) {
    return { trees: [], error: `Cannot read ${expanded}: ${String(e)}` };
  }
  if (!stat.isDirectory()) {
    return { trees: [], error: `Not a directory: ${expanded}` };
  }

  const live = liveSessionIds();
  const trees: Worktree[] = [];

  for (const name of readdirSync(expanded)) {
    if (name.startsWith(".")) continue;
    const full = join(expanded, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    trees.push({
      name,
      path: full,
      isGitRepo: existsSync(join(full, ".git")),
      sessions: readSessions(full, live),
    });
  }

  trees.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return { trees };
}

function NewSessionForm({
  worktree,
  onStarted,
}: {
  worktree: Worktree;
  onStarted: () => void;
}) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle={`New Session — ${worktree.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Start Claude"
            icon={Icon.Play}
            onSubmit={async (values: { name: string }) => {
              const name = values.name.trim();
              if (!name) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Name required",
                });
                return;
              }
              try {
                await launchClaude(worktree.path, { newSessionName: name });
                pop();
                onStarted();
              } catch (e) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Failed to launch",
                  message: String(e),
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description text={worktree.path} />
      <Form.TextField
        id="name"
        title="Session Name"
        placeholder='e.g. "refactor auth flow"'
        autoFocus
      />
    </Form>
  );
}

function NewWorktreeForm({
  defaultSourceRepo,
  worktreesRoot,
  setupCommandTemplate,
  onStarted,
}: {
  defaultSourceRepo: string;
  worktreesRoot: string;
  setupCommandTemplate: string;
  onStarted: () => void;
}) {
  const { pop } = useNavigation();
  const root = expandHome(worktreesRoot.trim());
  return (
    <Form
      navigationTitle="New Worktree"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create & Start Claude"
            icon={Icon.Plus}
            onSubmit={async (values: {
              sourceRepo: string;
              ticket: string;
              brief: string;
              base: string;
            }) => {
              const sourceRepo = expandHome(values.sourceRepo.trim());
              const ticket = values.ticket.trim();
              const brief = values.brief.trim();
              const base = values.base.trim() || "develop";
              if (!sourceRepo || !ticket || !brief) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Source repo, ticket and brief are required",
                });
                return;
              }
              const worktreePath = join(root, `${ticket}_${brief}`);
              try {
                await createWorktree({
                  sourceRepo,
                  worktreePath,
                  ticket,
                  briefName: brief,
                  baseBranch: base,
                  setupCommandTemplate,
                });
                pop();
                onStarted();
              } catch (e) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Failed to launch",
                  message: String(e),
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="sourceRepo"
        title="Source Repo"
        placeholder="~/Documents/Repos/your-repo"
        defaultValue={defaultSourceRepo}
      />
      <Form.TextField
        id="ticket"
        title="Ticket"
        placeholder="MP5-12345"
        autoFocus
      />
      <Form.TextField
        id="brief"
        title="Brief Name"
        placeholder="FixAuthTimeout"
      />
      <Form.TextField
        id="base"
        title="Base Branch"
        placeholder="develop"
        defaultValue="develop"
      />
      <Form.Description
        text={`Runs the setup command in the source repo, then opens Claude in ${root}/<ticket>_<brief>.`}
      />
    </Form>
  );
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const [state, setState] = useState<{ trees: Worktree[]; error?: string }>({
    trees: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const { push } = useNavigation();

  const refresh = useCallback(() => {
    setIsLoading(true);
    setState(loadWorktrees(prefs.worktreesRoot));
    setIsLoading(false);
  }, [prefs.worktreesRoot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openNewWorktree = useCallback(() => {
    push(
      <NewWorktreeForm
        defaultSourceRepo={prefs.sourceRepo ?? ""}
        worktreesRoot={prefs.worktreesRoot}
        setupCommandTemplate={
          prefs.setupCommandTemplate ??
          "./scripts/mpro-worktree.sh {ticket} {brief} {base}"
        }
        onStarted={refresh}
      />,
    );
  }, [
    push,
    refresh,
    prefs.sourceRepo,
    prefs.worktreesRoot,
    prefs.setupCommandTemplate,
  ]);

  const emptyDescription = useMemo(() => {
    if (state.error) return state.error;
    return `Configure the worktrees folder in extension preferences. Current: ${prefs.worktreesRoot}`;
  }, [state.error, prefs.worktreesRoot]);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter worktrees"
      navigationTitle="Spark Plug"
    >
      {state.trees.length === 0 ? (
        <List.EmptyView
          icon={Icon.Folder}
          title={state.error ? "No worktrees" : "No subdirectories found"}
          description={emptyDescription}
          actions={
            <ActionPanel>
              <Action
                title="New Worktree…"
                icon={Icon.NewFolder}
                shortcut={{ modifiers: ["cmd"], key: "n" }}
                onAction={openNewWorktree}
              />
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={refresh}
              />
              <Action.OpenInBrowser
                title="Open Extension Preferences"
                url="raycast://extensions/kylescudder/spark-plug"
              />
            </ActionPanel>
          }
        />
      ) : (
        state.trees.map((wt) => (
          <List.Item
            key={wt.path}
            title={wt.name}
            subtitle={wt.path}
            icon={wt.isGitRepo ? Icon.CodeBlock : Icon.Folder}
            accessories={
              wt.sessions.length > 0
                ? [
                    {
                      icon: Icon.Stars,
                      text: `${wt.sessions.length} · ${relativeShort(wt.sessions[0].lastModified)}`,
                      tooltip: `${wt.sessions.length} Claude session${wt.sessions.length === 1 ? "" : "s"}`,
                    },
                  ]
                : []
            }
            actions={
              <ActionPanel>
                <Action
                  title="New Session…"
                  icon={Icon.Plus}
                  onAction={() =>
                    push(<NewSessionForm worktree={wt} onStarted={refresh} />)
                  }
                />
                <Action
                  title="New Worktree…"
                  icon={Icon.NewFolder}
                  shortcut={{ modifiers: ["cmd"], key: "n" }}
                  onAction={openNewWorktree}
                />

                {wt.sessions.length > 0 && (
                  <ActionPanel.Submenu
                    title="Continue Session"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ["cmd"], key: "return" }}
                  >
                    {wt.sessions.map((s) => (
                      <Action
                        key={s.id}
                        title={sessionLabel(s)}
                        icon={s.isLive ? Icon.CircleFilled : Icon.Message}
                        onAction={async () => {
                          if (s.isLive) {
                            await showToast({
                              style: Toast.Style.Failure,
                              title: "Session is live",
                              message: "Quit it first, then resume.",
                            });
                            return;
                          }
                          try {
                            await launchClaude(wt.path, {
                              resumeSessionId: s.id,
                            });
                          } catch (e) {
                            await showToast({
                              style: Toast.Style.Failure,
                              title: "Failed to launch",
                              message: String(e),
                            });
                          }
                        }}
                      />
                    ))}
                  </ActionPanel.Submenu>
                )}

                {wt.sessions.length > 0 && (
                  <ActionPanel.Submenu
                    title="Delete Session"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
                  >
                    {wt.sessions.map((s) => (
                      <Action
                        key={s.id}
                        title={sessionLabel(s)}
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        onAction={async () => {
                          if (s.isLive) {
                            await showToast({
                              style: Toast.Style.Failure,
                              title: "Cannot delete a live session",
                              message: "Quit Claude first.",
                            });
                            return;
                          }
                          const confirmed = await confirmAlert({
                            title: "Delete this session?",
                            message: `This permanently deletes the transcript for "${sessionTitle(s)}".`,
                            primaryAction: {
                              title: "Delete",
                              style: Alert.ActionStyle.Destructive,
                            },
                          });
                          if (!confirmed) return;
                          try {
                            rmSync(s.filePath);
                            const companion = join(sessionDir(wt.path), s.id);
                            if (existsSync(companion))
                              rmSync(companion, { recursive: true });
                            refresh();
                          } catch (e) {
                            await showToast({
                              style: Toast.Style.Failure,
                              title: "Delete failed",
                              message: String(e),
                            });
                          }
                        }}
                      />
                    ))}
                  </ActionPanel.Submenu>
                )}

                <Action.Open
                  title="Open Folder in Finder"
                  icon={Icon.Folder}
                  target={wt.path}
                  shortcut={{ modifiers: ["cmd"], key: "o" }}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={refresh}
                />
                <Action
                  title="Delete Worktree…"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={async () => {
                    if (wt.sessions.some((s) => s.isLive)) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: "Cannot delete worktree",
                        message: "A live Claude session is running here.",
                      });
                      return;
                    }
                    const confirmed = await confirmAlert({
                      title: `Delete worktree "${wt.name}"?`,
                      message:
                        "This permanently deletes the folder and everything in it. If it's a git worktree, any uncommitted changes are lost.",
                      primaryAction: {
                        title: "Delete Worktree",
                        style: Alert.ActionStyle.Destructive,
                      },
                    });
                    if (!confirmed) return;
                    try {
                      removeWorktree(wt.path);
                      await showToast({
                        style: Toast.Style.Success,
                        title: "Worktree deleted",
                        message: wt.name,
                      });
                      refresh();
                    } catch (e) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: "Delete failed",
                        message: String(e),
                      });
                    }
                  }}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

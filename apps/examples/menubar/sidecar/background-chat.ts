// SPDX-License-Identifier: Apache-2.0
// Host-local background launch boundary. The sidecar supplies its existing clients.
export interface BackgroundChatContext {
  workspaceRoot: string;
  cwd?: string;
  provider: string;
  model: string;
}
interface BackgroundConfig {
  workspaceRoot: string;
  cwd: string;
  provider: string;
  model: string;
  apiKey?: string;
  enableTools: boolean;
  enableSpawn: boolean;
  enableTeams: boolean;
}
export interface BackgroundChatDependencies {
  context(): BackgroundChatContext | undefined;
  auth(provider: string): { apiKey?: string };
  start(input: BackgroundConfig & {
    autoApproveTools: boolean;
    source: string;
    interactive: boolean;
  }): Promise<{ sessionId: string }>;
  send(sessionId: string, input: {
    config: BackgroundConfig;
    prompt: string;
  }): Promise<unknown>;
  notify(body: string): void;
}
export async function launchBackgroundChat(
  prompt: string,
  dependencies: BackgroundChatDependencies,
): Promise<void> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) return;
  const selected = dependencies.context();
  if (!selected) {
    dependencies.notify("No recent workspace and model context is available yet.");
    return;
  }
  // UI events can replace the recent context while session creation is pending.
  const context = { ...selected };
  try {
    const cwd = context.cwd ?? context.workspaceRoot;
    const launchAuth = dependencies.auth(context.provider);
    const started = await dependencies.start({
      workspaceRoot: context.workspaceRoot,
      cwd,
      provider: context.provider,
      model: context.model,
      apiKey: launchAuth.apiKey,
      enableTools: true,
      enableSpawn: false,
      enableTeams: true,
      autoApproveTools: true,
      source: "cline-menubar",
      interactive: false,
    });
    await dependencies.send(started.sessionId, {
      config: {
        workspaceRoot: context.workspaceRoot,
        cwd,
        provider: context.provider,
        model: context.model,
        apiKey: launchAuth.apiKey,
        enableTools: true,
        enableSpawn: false,
        enableTeams: true,
      },
      prompt: trimmedPrompt,
    });
  } catch (error) {
    dependencies.notify(error instanceof Error ? error.message : String(error));
  }
}
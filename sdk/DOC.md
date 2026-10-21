
## Host completion checks

`AgentRuntimeConfig.completionGate` accepts a synchronous or asynchronous host
function returning `allow`, `continue` with a diagnostic, or `blocked` with a
diagnostic. The candidate and source (`text`, `tool`, or `tool-result`) are supplied
before delivery. Host policy owns persistence, verification, and bounded
continuation state; the stateless runtime does not access storage.

When configured, final text/media delivery waits for the check. A refused text
candidate is not added to the public transcript. Completion tools are checked
before execution after input rewriting, and successful results are checked again
after tool hooks. Completion-tool streaming updates are withheld; the checked
result supplies output. Invalid decisions and check failures block the run.
`continue` delivers corrective diagnostics to the model, while `blocked` ends
with diagnostic output and no successful run status. Core's legacy event adapter
maps `blocked` to its existing error finish reason.

The gate is independent of optional completion-tool policy and plugin hooks.
Disabling completion tools for a text-only model does not disable an injected
gate. Applications must inject their own policy and propagate it to every
runtime; the generic SDK does not make a missing gate mandatory.

## Detached daemon runtime registration

`registerHubDaemonRuntime({ sessionHost, peerIdentity })`, exported from
`@cline/core/hub`, binds an already constructed host before importing
`@cline/core/hub/daemon-entry`. The immutable process-wide binding survives
separately bundled module copies. Repeating the same host/identity is harmless;
replacing either is refused. Identity fields are captured, not borrowed from a
mutable options object. The server disposes the host during shutdown or failed
binding. A failed bind does not retry that disposed instance.

`getHubDaemonRuntime()` rejects missing or mismatched registration when trusted
host identity requires it. Unregistered generic SDK callers retain the default
runtime. `createLocalHubScheduleRuntimeHandlers({ sessionHost })` routes start,
run, abort and stop through that host without creating a second runtime or store;
the caller owns its fetch, telemetry, policy and lifecycle construction. Host
refusals propagate without a fallback. These APIs are injection points, not proof
that a supplied host implements governance.

## Host runtime construction

`ClineCoreOptions.configureAgentRuntime` is a trusted, local host callback that
returns the complete `AgentRuntimeConfig`, synchronously or asynchronously. Core
captures it when constructing the local host and applies it after optional
contribution resolution on every fresh runtime, including continuation and
restore. Lead agents and delegated subagents/teammates inherit the factory; each
invocation receives its own agent, parent, session and conversation identity.
Its second argument is an immutable `{ cwd, workspaceRoot }` snapshot captured
from the host's session configuration before optional setup. Core supplies the
actual working directory and configured project root to roots, delegated agents
and teammates, including fallback/nested `spawn_agent` construction. Delegated
connection refreshes and returned configuration objects cannot replace a captured
host factory, root session ID or workspace. An explicit delegated `cwd` remains
distinct from its configured project root.

The factory owns per-agent policy state and must not share mutable lifecycle state
between independent agents. `AgentConfig.configureAgentRuntime` is the equivalent
input for direct `SessionRuntime` consumers, which supply `cwd` and `workspaceRoot`
explicitly. Missing fields remain undefined; neither process cwd, optional metadata
nor prompt text substitutes for them. A product factory must validate required
absolute workspace paths before loading workspace policy. The generic SDK permits
missing workspace context for consumers that do not require such policy.

Setup rejection prevents runtime construction and releases session run admission
so a later attempt can recover. Cancellation while finite asynchronous setup is
pending is retained and delivered when the runtime starts, before model dispatch;
the callback itself must settle (Core does not terminate arbitrary host work).

This callback cannot be serialized to another process. Supplying it with `auto`,
`hub` or `remote` execution refuses routing before discovery, daemon prewarming or
connection. Install policy on the execution host and explicitly use local mode
there. The generic SDK does not require a callback, and this extension point alone
does not establish mandatory policy in shipped products or authenticate a hub.

## Host-owned tool registrations

`AgentRuntimeConfig.requiredTools` supplies host-owned local tools independently
of optional tools and plugin discovery. The runtime captures each implementation
and freezes a detached copy of its plain-data metadata at construction. Names
must be unique and nonblank. Optional config or plugin tools using a reserved
name fail initialization before a model request. Restoring conversation history
retains these registrations. Core forwards `AgentConfig.requiredTools` even when
optional completion tools are disabled.

Registration does not guarantee advertisement or execution: optional model hooks
can remove advertised tools, and optional tool policy can refuse execution.
Hosts must compose their mandatory policy with the model and tool gates. This
protects against supported hook/config mutation, not arbitrary hostile code in
the same JavaScript process or mutable state captured inside an implementation.

## Host-only tool execution at provider dispatch

A trusted model request gate may set `AgentModelRequest.toolExecutionPolicy` to
`host-only`. The stateless runtime refuses the request unless the actual adapter
declares `enforcesHostToolExecution === true`; it captures this declaration with
the stream method before awaiting authorization. Explicit provider-executed
`modelTools` are incompatible and block before dispatch. Unknown declarations
are refused. Ungoverned callers that omit the policy keep existing behavior.

The gateway implements this contract recursively: authorized runtime tool
definitions override handle defaults, default provider tools cannot reappear,
and a provider must declare enforcement support before its stream runs. Native
HTTP AI SDK adapters declare host-controlled tools and refuse model operations
that would discard required definitions. Agent-backed adapters declare internal
execution and are refused before loading their agent SDK; Dify and SAP adapters
are currently unproven and also refused for host-only requests. Provider IDs do
not decide admission: adapters declare their transport behavior when constructed.
The policy is internal and is not sent as a provider API option.

The private required-model gate always requests this policy. An adapter's
declaration is a trusted implementation contract, not a sandbox for malicious
code or proof about arbitrary behavior of a remote service. Shipped factories
must still install the private gate and final local tool/audit/completion gates.

## Host model request authorization

`AgentRuntimeConfig.modelRequestGate` receives a detached final request directly
before each model adapter call, after optional hooks, compaction and observers.
Return `allow` with a complete authorized request or `blocked` with a diagnostic.
Invalid decisions and exceptions block dispatch. The authorized result is cloned;
the runtime keeps its own cancellation signal. Cancellation while waiting wins.
Core forwards this callback in text-only configurations. The host owns mandatory
guidance restoration and provider-internal capability admission; supplying this
generic callback alone does not establish either product guarantee.

## Private required-model policy

The internal `@cline/qbrain-governance` package exports `createRequiredModelGate`.
Pass the verified V2 host's `getRequiredModelContext` binding; the gate captures
that callback, reads required guidance for each dispatch, appends it after the
final system prompt, and replaces optional advertised definitions with trusted
required definitions. Empty or malformed context and source failures block
dispatch with a diagnostic that excludes transport details. Ordinary optional
tool definitions remain available. It always requests host-only tool execution,
so undeclared adapters or explicit provider-executed tools are refused at dispatch.
Every shipped host must still install this callback and durable lifecycle policy.

The explicit cross-repository test command is:

```sh
node sdk/packages/qbrain-governance/scripts/verify-v2-host.mjs /absolute/path/to/candidate.tgz <recorded-sha256>
```

It installs checksum-verified packed V2 bytes in a private temporary directory away
from workspace node_modules, authenticates through `bootstrapGovernedPlugin`,
and passes the host's actual SDK tool factory. Synthetic signed-marker/bridge
fixtures cover final guidance/tool restoration, continuation/restore, source/asset
refusal and reserved registration. No SDK peer lookup, startup download or global
module hook is needed for this governed entry. Audit acknowledgments do not
establish real A8 persistence or phase acceptance.

`bootstrapGovernedPlugin` composes canonical plugin-core archive verification and
signed marker/nonce authentication for the exact workspace before installation or
import. It imports captured verified bytes, then reauthenticates before each host
construction and rejects contract drift. Host-owned workspace, agent, fetch,
artifact binding and installed plugin root cannot be overridden by configuration.
Only contract metadata is returned; marker credentials stay internal. The canonical
core archive is a checksum-recorded vendored build dependency with original licenses
preserved. This candidate dependency is not an accepted release pin.

`loadVerifiedPluginHost` consumes a host-authorized `PreparedPluginInstallation`
and an existing private product directory. Signed marker and reviewed pin
authorization must happen before this call. It rechecks the complete installation
before import, requires the canonical `./host` export, and rechecks again before
each host construction. Configuration cannot redirect `pluginRoot`. Failed import
removes only the fresh installation and exposes a generic diagnostic. Successful
installations remain owned by the host for the lifetime of their plugin instances.
This is the loading boundary; it neither accepts release pins nor installs the
product's mandatory lifecycle, audit and completion gates.

## Host tool authorization

`AgentRuntimeConfig.toolExecutionGate` checks each local tool call after optional
input/policy rewriting, approval handling, and awaited `tool-started` observers,
immediately before dispatch. It receives final arguments, base and effective
policy, a runtime snapshot, and cancellation signal. Inputs are detached plain
data; the check receives a deeply frozen copy, and execution uses a separate copy.

Return `allow` to dispatch, `deny` with a diagnostic to let the model correct its
request, or `blocked` with a diagnostic to stop the run. Invalid decisions,
uncloneable/non-plain input, and check exceptions block. Optional after-tool hooks
cannot convert a refused execution into a successful tool result. Sequential
calls are checked after preceding calls finish; each parallel call is checked
independently. Blocking does not undo a parallel call that already began.

The host owns mandatory approval and policy enforcement, including rejecting any
optional policy override that would weaken its requirements. Core preserves the
callback when constructing a runtime. Applications must install it on every
governed runtime; an absent callback retains generic SDK behavior. This gate
covers local dispatch only. Provider-side execution requires separate capability
validation before sending a model request.

## Mandatory local tool outcomes

`AgentRuntimeConfig.toolResultGate` acknowledges the original execution outcome
before optional `afterTool` hooks can rewrite it or throw. It receives detached,
deeply frozen plain-data arguments captured before execution, the raw result,
an `executed` flag, measured timestamps/duration, runtime identity and signal.
Refused and unknown calls are reported with `executed: false`; execution errors
are reported with `executed: true`. Settled executions still reach this boundary
after cancellation. Cancellation then stops continuation without running optional
after-tool hooks. A process crash before acknowledgment remains the host's durable
pre-execution/outbox recovery responsibility.

Return `allow` after the host has handled its outcome obligation, or `blocked`
with a diagnostic. Missing/malformed decisions, exceptions and outcomes that
cannot be cloned as plain data block the run. A blocked result skips optional
after-tool hooks and prevents subsequent local dispatch, including when no
`toolExecutionGate` was installed. Already running parallel calls still settle
and report their own results. This callback does not retry execution or claim
durable persistence by itself. Core forwards it; generic callers can omit it.
The completion gate runs after outcome acknowledgment and optional hooks before
delivering a successful completion-tool result. Host composition must bind the
callback to actual durable lifecycle storage; optional hooks are not that boundary.

## Oversized tool result recovery

Cached text excludes native image data. Cache admission uses the persisted JSON/string model-preview size for the truncation threshold; YAML size controls only cache capacity. Plain strings stay unchanged; structured cached text is serialized as YAML, preserving multiline payloads as literal blocks without automatic wrapping. Original history and tool events keep their existing format. Recovery uses the existing `read_files` output and per-line limits; disabling that tool does not disable caching or remove recovery notices.

Tools created with `createTool` may set `resultPolicy: "cache-oversized"`. Core enables this for MCP and Composio tools. Original output remains in history and events; synchronous model preparation sends a bounded preview with a `cline://cache/<encoded-session-id>/<result-id>.result.txt` URI for cached oversized responses. Use `read_files` with `start_line`/`end_line` to read omitted content. Shell and filesystem search tools do not support these URIs. The stateless agent runtime does not own a cache.

Entries expire after five further model iterations without a cache read, across follow-up turns. Explicit reads refresh expiry; model requests do not. A 16 MiB UTF-8 text limit per session evicts least recently read entries; individually larger results have no recovery URI. Shutdown, history reset, and restore clear the cache, and resume does not regenerate entries. Missing reads instruct the agent to refetch with an appropriate read/query tool without repeating side-effecting actions. Evicting cached text does not remove original conversation output or change earlier recovery notices; URI references remain until the cache is cleared. Cache-miss feedback appears only when an agent attempts to read missing content.

## Shared agent review UI

`@cline/ui` exports presentation-only components for showing a session's changed
files and pull-request status. Configure Tailwind v4 and a token entry point before
importing `@cline/ui/components.css`, following the
[complete styling setup](./packages/ui/ADOPTION.md#option-2-tailwind-mappings-without-base-styles).
Then import the components from the package root:

```tsx
import {
  AgentChangedFile,
  AgentChangesPanel,
  AgentPullRequestBar,
} from "@cline/ui";
```

`AgentChangesPanel` owns the Changes header, count, close action, empty state,
and scroll region. Compose `AgentChangedFile` children to show collapsible paths,
copy feedback, additions/deletions, host-provided actions, and rendered diff
content. The host retains change collection, clipboard and editor integration,
and conversation focus.

`AgentPullRequestBar` accepts normalized `AgentPullRequestData` plus loading and
error state. The host owns refresh, polling, navigation, and telemetry, and
provides its accessible checks popover through `renderChecks`. Native hosts can
intercept links with `onNavigate`; web hosts can omit it to render external
anchors. `getAgentPullRequestMergeStatus` and
`summarizeAgentPullRequestChecks` expose the same status normalization for other
host presentation.

## Fork metadata

`createForkSessionMetadata` from `@cline/core` copies metadata, replaces fork ancestry, and removes inherited handoff markers. Callers supply the source ID, timestamp, source, and optional `beforeRunCount`; titles and session creation remain caller-owned.

## Cloud sessions (experimental)

`CloudSessionApi` and `CloudSessionController` are exported from `@cline/core/cloud`.
The API handles REST requests; the controller handles remote Hub connections,
session lifecycle, transcript reconciliation, and approvals. Hosts provide API
URLs and a fresh-token callback; feature gating and account selection stay in the
host. Importing this subpath does not start a local agent.

Use `subscribe` for immutable snapshots and live events, `attach`/`readMessages`
to open a session, and `send` for a follow-up. Attaching a provisioning or failed
session returns its receipt without connecting. `detach` closes this viewer, not
the remote task. Call `dispose` when the host shuts down.
Viewers hydrating active runs with `readMessages` reconcile canonical history at
completion even when they missed the run-start event and earlier content deltas.

`create` accepts `sandboxType: "standard" | "resumable"` (default: `"standard"`).
The controller resumes suspended sessions when opened and restores their saved tasks.

Hosts replacing controllers during credential refresh can share the
`pendingInitialTasks: Map<string, CloudCreationOptions>` constructor option.
It retains first-task approval/thinking/reasoning preferences, including updates
through `restoreCreationOptions`, until the inner task is found or created (or
the outer session is deleted). `dispose` preserves an injected map; without one,
the controller owns and clears its pending state. Restoring options alone never
authorizes recreation of a missing established task.

## Experimental cloud handoff

`loadCloudModels` and `CloudSessionController.listModels()` provide eligible cloud
models. Handoff requires the selected model; it never substitutes another.

Use `create({ handoff, ... })` to provision and seed, or `seedHandoff(id, seed)` for
an existing target. Persist target IDs and dispatch markers through the callbacks;
use `recoverOnly` after uncertain dispatch to avoid duplicate conversations.
Handoff creation requires `onCreating`: durably save intent before returning, and reject a previously unconfirmed intent after restart.
Callback errors preserve their original type; they do not prove an earlier POST was rejected or permit clearing its intent.
`CloudHandoffSeedRejectedError` means no seed was dispatched; clear only the seed marker before retrying the saved target.
`verifyHandoffTranscript` checks the seeded history; `waitUntilReady(id)` waits for provisioning.

## Voice input models

`getLocalTranscriptionModels(providerId, config?)` from `@cline/core` returns the
voice models supported by a provider's transcription transport. Use it to build
voice pickers rather than filtering the bundled chat catalog. Vercel uses its live
model list and advertised streaming tags; unavailable or malformed responses fail
discovery rather than restoring stale bundled models. Voice selection saves and
both batch and streaming execution revalidate through the same service.

`isTranscriptionModel` from `@cline/shared` (also exported for browsers) accepts
exact audio-only input and text-only output modalities. An explicit transcription
label does not override additional input or output modalities. Multimodal live
models are classified as `realtime`, which currently has no built-in transport
support and is excluded from voice and chat pickers. Dedicated transcription can
still use either batch or streaming mode. Classification alone does not prove
that a provider implements the required transport.

`createStreamingAudioTranscriptionSession` mints short-lived Vercel or single-use
ElevenLabs credentials. Its shared response includes `transport` and `sampleRate`;
browser clients must capture PCM at that rate (Google live routes require 16 kHz).
ElevenLabs exposes batch `scribe_v2` and live `scribe_v2_realtime` separately.

## SSH remote environments

`RemoteEnvironmentService` (exported by `@cline/core` and `@cline/sdk`) owns SSH
profiles, connection testing, helper installation, authenticated loopback tunnels,
remote commands, status changes, and cleanup. It runs in the client's Node host;
browser clients expose this API through their host transport. No desktop code is
required. OpenSSH config aliases, identity files, and ssh-agent authentication are
supported. Connections use batch mode and require an already-trusted host key in
OpenSSH known_hosts (or `knownHostsPath`). Before first use, verify the server
fingerprint through a trusted channel and enroll it using your SSH client. Unknown
or changed keys are rejected before inspection, upload, or execution.

```ts
import { ClineCore, RemoteEnvironmentService } from "@cline/core";

const environments = new RemoteEnvironmentService({
  helperBinaryDirectory: "/opt/my-client/remote-helpers",
  onStatusChange: (status) => console.log(status),
});
const profile = await environments.upsert({ name: "Build host", host: "builder" });
const connection = await environments.connect(profile.id);
const core = await ClineCore.create({
  clientName: "my-client",
  backendMode: "remote",
  remote: {
    endpoint: connection.endpoint,
    authToken: connection.authToken,
    workspaceRoot: connection.workspaceRoot,
  },
});
try {
  // The ordinary session, tools, approvals, and event APIs execute on this host.
  // Supply provider credentials in the session config, as for other remote hubs.
  console.log(await core.list());
} finally {
  await core.dispose();
  await environments.dispose();
}
```

The service also exposes `list`, `upsert`, `delete`, `test`, `disconnect`, `run`,
`getConnection`, `getActive`, `activateConnection`, and `getStatuses`.
`onConnectionLost` lets clients retire runtime bindings after a tunnel fails.
Each service instance has a unique remote Hub discovery record, so another
client connecting to the same host cannot stop its Hub.
Connect/disconnect/profile mutations are serialized; concurrent connects reuse
one tunnel. Dispose the `ClineCore` runtime before disconnecting its environment.
Do not expose the connection's authentication token to a browser or logs.

Profiles default to `~/.cline/data/settings/remote-environments.json`, written
atomically with mode 0600. They contain identity-file paths, never private keys.
Options include `profilesPath`, `sshPath`, `knownHostsPath`, process timeouts,
`helperBinaryPath`, and `helperBinaryDirectory`. The corresponding helper/SSH
configuration variables are `CLINE_REMOTE_HELPER_BINARY`,
`CLINE_REMOTE_HELPER_DIRECTORY`, `CLINE_SSH_PATH`, and
`CLINE_SSH_KNOWN_HOSTS_FILE`.

Clients package a matching self-contained helper using the
`@cline/core/remote/helper-entry` executable entrypoint, compiled with Bun for the remote OS and
architecture. Use `remoteHelperBinaryFilename({ platform, arch })` for the
filename (`cline-remote-helper-<target-triple>`). Linux and macOS on x64/arm64
are supported. Helpers must include the same SDK build as the client; missing
helpers produce an explicit error, without installing a runtime from the network.
The helper implements `--remote-hub-ensure --cwd <path> --discovery-path <path>`
and the core detached-daemon sentinel. Agent tools and persistence run remotely;
the host only manages SSH and forwards the authenticated hub connection.

### Provider authentication metadata for host UIs

`@cline/shared` (including its browser entry point) exports `ProviderAuthInfo`,
`ProviderLocalCli`, `resolveProviderLocalCli(provider)`, and
`resolveProviderApiKeyOptional(provider)`. The resolvers accept provider data
(`metadata.localCliCommand` with optional `docsUrl`, and `metadata.apiKeyOptional`);
they perform no registry lookup. Hosts resolve providers through `@cline/llms` and
then pass that data to the shared helpers. `listLocalProviders` includes the
resulting facts in each `ProviderListItem.auth` (`localCli`, and `apiKeyOptional`
for local inference servers and cloud-credential providers that run without a
key), allowing browser clients to render authentication guidance and gate sessions
without importing the LLM catalog. `ProviderListItem.modelTools` likewise
carries provider-level native tool availability for settings indicators.

## Concurrent subagent tool calls

`spawn_agent` and configured `subagent_*` tools declare
`executionMode: "parallel"`. Consecutive calls to these tools in one model
response run concurrently even when the parent runtime uses its default
sequential mode. Each call still returns its child's completed answer, and tool
results remain in the model's original call order.

A tool's optional `executionMode` overrides the runtime's `toolExecution` setting.
Unmarked tools inherit the runtime setting. Sequential calls form ordering
boundaries: `read_file → [spawn A, spawn B] → edit_file` executes the read first,
then both child runs together, then the edit after both finish. This does not
change the execution mode of tools inside the child agents.

Preparation remains serial for the whole response, before any tool executes.
All before-tool hooks and required approvals therefore complete before the
parallel group starts. A before-tool `skip` blocks its own call; a before-tool
`stop` prevents the entire response's execution, as before. Pending approvals
can delay sibling execution. No background-run handles or new concurrency
limit are introduced.

### Configured subagent approvals

Configured agents do not expose a tool approval policy setting. The parent’s
`subagent_<name>` call follows the parent session’s approval policy; the child
executes its available tools without inheriting that policy or approval callback.
Its configured `tools` allowlist and disabled-tool filtering still apply. Runtime
hooks remain inherited and can block tool execution.

## Saving provider credentials

`saveLocalProviderSettings` is asynchronous; callers must await it before
reloading provider catalogs or continuing onboarding. When a saved
provider has a `modelsSourceUrl`, credential, header, and base URL updates refresh
its model list before saving the new settings. `updateLocalProvider` follows the
same rule even when the request omits `models` and `modelsSourceUrl`. Endpoint
changes relocate same-origin model sources; separate catalog origins remain
unchanged. Model refresh in `saveLocalProviderSettings` is best-effort: if it
fails during discovery, the new settings are still saved and the last known
catalog is retained. Settings and catalog persistence errors still reject the save.
Provider-service mutations are serialized per catalog file within the process,
including across manager instances and different providers. Discovery prepares
the update before the complete settings patch is persisted once. If the catalog
write fails, the prior provider settings are restored only while the failed
operation still owns the current settings entry; newer saves and removals are
preserved. A rollback failure is reported alongside the original error.
Explicit `updateLocalProvider` calls still reject failed model fetches and retain
the prior settings and catalog.

Catalog refreshes replace discovery-owned model IDs while retaining manually
added models, their default selection, and overrides on retained model entries.
`models.json` records discovery-only IDs in `discoveredModelIds`; IDs also supplied
explicitly are user-managed. An explicit `models` update replaces the manual list.
An existing model selection in provider settings does not count as a manual
addition when initializing a source-backed catalog.
Provider capabilities are inherited when registering models, so stored per-model
capability overrides continue to take precedence after refreshes.

## Shared UI session rows

`@cline/ui` exports `AgentSessionRow`, `AgentSessionRowEditor`, and
`AgentSessionOverview`, together with their public props types. These are
presentation primitives for session navigation, rename, and metadata content;
the host retains session data, routing, menus, permissions, formatting, and
interaction policy. Import the shared component stylesheet with the host theme.

`AgentSessionRow` owns the row geometry, selected/hover appearance, timestamp
placement, and pending/provisioning/running/unread status-dot precedence. Hosts
provide the already-formatted `label` and `timestamp`, optional `leading` and
`pinnedIndicator` content, and a sibling `action`. Root DOM props and refs pass
through to the row wrapper for host-owned context-menu or hover-card triggers.

The default control is the desktop native `button`; its `disabled` and
`onSelect` props apply only in that mode. URL or router navigation uses the
mutually exclusive `renderControl` mode, which receives the shared navigation
`className` and row `children` for the host's link or router control. The host
control owns its href, accessibility, disabled behavior, and event handling.
The control union prevents combining `renderControl` with `disabled` or
`onSelect`, and keeps optional actions as siblings so interactive elements are
not nested.

`AgentSessionRowEditor` supplies the matching edit frame while the host owns
the rename input, focus, Enter/Escape/blur handling, and saving state.
`AgentSessionOverview` renders a title and `[label, value, fullValue?]`
metadata rows; the host owns the hover-card lifecycle, positioning, and
metadata formatting. See the [session-row adoption guide](./packages/ui/ADOPTION.md#session-rows)
for the import, slot, and trigger/ref examples.

## Shared context usage presentation (`@cline/ui`)

`AgentContextUsage` exposes desktop's context ring and token breakdown through
its `children` render callback. It adds no wrapper: the host receives
`AgentContextUsagePresentation` (`triggerLabel`, `ring`, and `details`) and keeps
its own accessible trigger, popover, positioning, focus, and keyboard behavior.

`AgentContextUsageProps` accepts `usage: AgentContextUsageData`, optional
`costLabel: ReactNode`, and the required render callback. Usage contains
`tokensIn`, `tokensOut`, `cacheReadTokens`, and optional `contextWindow`.
Supply current-request metrics and the model's authoritative context capacity,
not accumulated session token traffic. The component renders nothing when
usage is empty or context capacity is unavailable or nonpositive. Cached tokens
are part of input usage, not additional context consumption.

`costLabel` is a separate host-formatted cost. Numeric zero is displayed;
previously hidden falsy values remain omitted. Desktop retains its existing
cost formatter and usage source. Import the component and all three public
types from `@cline/ui`; see [UI adoption guidance](packages/ui/ADOPTION.md) for
theme setup, styling, and composition examples.

## Shared command output and image presentation (`@cline/ui`)

`AgentCommandOutput` renders `output` with a running cursor controlled by
`isRunning`. Optional `children` let the host retain ANSI rendering or normalize
control characters. It follows new output initially, pauses when the user
scrolls away, and resumes within 24px of the bottom. Hosts own output collection,
limits, and session identity; remount it when switching commands. `tabIndex` and
`classNames.viewport` / `classNames.cursor` allow host-specific accessibility styling.

`AgentImageLightboxContent` renders an image and two close controls calling
`onClose`. The host owns the dialog, positioning, Escape handling, focus management,
and image navigation. `backdropTabIndex` can exclude the backdrop from a managed
dialog's tab order. Image source validation and resolution remain host-owned;
provider-generated URLs must go through an explicit host trust policy before
rendering. This presentation primitive does not replace `GeneratedMediaContent`
or its inline-byte validation.

## Shell executor errors

The executor returned by `createShellExecutor` rejects on execution failure.
The following error classes are exported from `@cline/core` so hosts can
distinguish process outcomes without parsing messages. They are not an exhaustive
list of rejections: cancellation, timeout, and stdin-write failures can reject
with other errors.

- `CommandExitError` — the shell started and exited non-zero. `exitCode` is the
  numeric process exit code and `output` contains a completion notice and the
  captured output (subject to the configured truncation limit).
- `CommandTerminationError` — the process terminated without a numeric exit
  code. `signal` is the terminating signal, or `null` if none was reported;
  `output` contains a termination notice and the captured output. This error
  has no `exitCode` field.
- `CommandSpawnError` — the shell process could not be started, so there is no
  exit code. The message keeps the pre-existing `Failed to execute command: …`
  form. `code` is the operating system error libuv reported (`ENOENT`,
  `EACCES`, `EFTYPE` for a file that is not a valid executable). Because spawn
  reports `ENOENT` with the same message when the executable is not found and
  when the working directory no longer exists, `missing` records which path was
  absent at failure time: `"executable"` or `"cwd"`. It is `undefined` for every
  other code. `code` itself is `undefined` if the underlying error has no code.

The public `run_commands` tool catches executor failures and resolves with
per-command results containing `success: false`, rather than propagating these
errors as rejected tool calls. For `CommandExitError` and
`CommandTerminationError`, the failed result retains `output` in its `result`
field. For `CommandSpawnError`, `result` is empty and `error` includes the spawn
failure message. Hosts that need the structured error fields must observe the
executor rejection before this conversion.

Hosts that record command telemetry should label a `CommandSpawnError` by its
`code` (and `missing`) rather than inventing an exit code. The VS Code and
standalone adapters do this in the `errorCode` dimension, and use the bounded
labels `signal` and `no_exit_code` for `CommandTerminationError`. Only an actual
numeric exit is reported as `exitCode`.

## Unknown model completion recovery

The AI SDK adapter maps unified `length` to `max-tokens` and missing or unrecognized reasons (including `other`) to `unknown`. Explicit `stop`, `tool-calls`, `content-filter`, and `error` retain their meanings. The agent also treats a stream without a finish event as unknown.

Without tool activity, an unknown response is preserved in history and continued once, with the model-visible user message “Previous turn ended unexpectedly. Continue from where you left off.” The message uses `displayRole: "system"` and `userRunSpan: 0`, matching injected hook context so it stays out of live and replayed chat transcripts. The system prompt is unchanged. A second unknown completion fails the run. Queued user instructions are consumed before the continuation, including in the first iteration. Tool calls receive their results through the normal loop; provider-executed actions are not replayed.

## Host-required hub identity

Trusted product bootstrap can register an immutable `HubPeerIdentity` through
`registerHubPeerIdentity`: an application ID and the verified governance policy's
lowercase SHA256 digest. A hub namespace can require this initialization with
`requirePeerIdentity`; missing identity then refuses hub operations. The private
cline-qb namespace requires it. This API does not derive or approve policy digests.
The host must obtain the digest from its verified policy before optional setup.

Both socket clients, including subsequent connection attempts, verify the existing
authenticated `/status` endpoint before opening a socket. Discovery reuse and
cached in-process server reuse also verify the peer. Identity is never accepted
from a discovery file or public health/version response. The product and policy
must match exactly; missing authentication, malformed identity, timeout, redirect
or mismatch refuses attachment. Identity probes have a five-second deadline and
omit endpoint secrets and server response bodies from refusal messages. Header-only
connections cannot establish this token-authenticated product identity and refuse
when a host identity is required. Generic SDK clients without a registered or
required policy retain their existing connection behavior.

Servers explicitly declare `peerIdentity` alongside a caller-owned `sessionHost`.
The server snapshots that declaration before creating resources and only publishes
it in authenticated status. Client expectations never automatically turn into a
server declaration. The host remains responsible for governing every session
constructed by that owned host; this boundary does not install the product factory.

Drain and shutdown verify identity before control requests and refuse redirects.
Governed retirement never signals a recorded PID. It retains discovery unless a
connection refusal shows the listener has stopped; authentication failure, a live
HTTP response, timeout or another transport error is insufficient. Generic daemon
retirement keeps its existing behavior. The identity contract assumes trusted host
bootstrap and the existing bearer-token transport, not isolation from malicious
code executing inside the same process.

The required V2 host also exposes readVerificationPolicy() for host-owned
verification and completion control. It uses the existing bound canonical bridge
and attestation verifier, rechecks marker trust on every read, rejects credential,
endpoint or contract rotation until a new trusted host is constructed, and returns
only fresh immutable signed policy data. Policy browsing opens no session or turn.
The loader refuses hosts lacking this capability. This API does not register a
production verification map, accept a release pin or replace the A8 lifecycle.

For governed hosts, `retireDiscoveredHub(record, discoveryPath)` requires
matching authenticated product/policy identity, never signals a recorded PID,
and confirms listener retirement before returning `true`. Discovery removal is
conditional on the generation captured before shutdown, with matching endpoint
and authentication token. Missing/malformed or superseded discovery is retained.
A `false` result is not permission to start a replacement or clear discovery.
CLI `hub upgrade` also requires a successful drain and positive idle observation;
`doctor fix` uses this same retirement path when peer identity is required.


### Governed hub build identity and workspace verification policy

The private governance build embeds a deterministic SHA256 identity over the SDK
runtime/dependency graph, private governance runtime/build inputs, and vendored
canonical plugin-core archive. Trusted bootstrap combines that identity with the
exact canonically verified V2 artifact binding and exposes an immutable
`peerIdentity` for the hub handshake. Missing build preparation refuses bootstrap;
runtime environment values cannot override the embedded identity. Bootstrap still
authenticates each workspace and reauthenticates every host construction.

Hub `policyDigest` identifies the common enforcement build plus reviewed plugin
artifact. It is distinct from both the signed plugin contract digest and a
workspace's signed verification-policy digest. Separate workspaces can share the
same hub enforcement identity while their policies, credentials, source fingerprints
and completion evidence remain workspace-bound. Policy rotation invalidates that
workspace's verification evidence; it does not change the common build identity.
This follows the approved shared-hub and policy/build identity requirements.

This bootstrap surface alone does not register a live daemon or establish A8/S6
lifecycle readiness. Shipped hosts must supply the mandatory governed session
factory before advertising or registering the identity. Successful product startup,
accepted plugin pins and the cumulative phase gate remain required.


### Governed discovery refusal and cold startup

Governed discovery consumes the same authenticated status response that passed
the hub identity check. It validates status shape and the advertised endpoint,
retains the caller's discovery credential, and never follows a status redirect.
Identity/authentication refusals, malformed status, timeouts and DNS failures
preserve discovery and block replacement. Only transport ECONNREFUSED establishes
absence; its public error carries no original URL, token, body or cause.

Without discovery credentials, a preflight may establish an unused listener by
connection refusal. Any response or uncertain transport blocks spawning. After a
host-owned launch, clients wait for authenticated discovery publication, allowing
the listener-before-record startup window without attaching on health alone.
Recovery removes only the observed discovery generation and refuses if a successor
has replaced it. Governed startup does not retire legacy shared-hub records or use
fallback ports. Generic unregistered SDK recovery behavior remains unchanged.

### Current input at run-start hooks

`beforeRun` receives `context.input` separately from the pre-run conversation
snapshot. Core passes the actual current prompt with `appendInput: false` because
its persisted history already includes this turn. Hosts using this option must
seed that input themselves; it does not alter hook ordering. Empty strings retain
the existing no-append behavior, while hooks still distinguish them from undefined.
The lifecycle input preserves the exact string (including whitespace and an explicit
empty string), or the supplied message/message-array shape and IDs. An inputless
`continue()` supplies `undefined`; it never substitutes an earlier user message.
`afterRun` continues to receive only the snapshot and result.

The runtime captures input synchronously before asynchronous plugin setup and
makes a separate detached data copy for each run-start hook. Caller mutations
during setup and hook mutations cannot rewrite the admitted input or another
hook's observation. Messages support plain data, cycles, Dates, URLs, Uint8Arrays
and ArrayBuffers, using the model-request data copier. Executable values, symbols
and unsupported class instances in input are rejected before initialization or
model dispatch rather than retained by reference. This tightens the accepted
message-data contract; callers must project opaque application objects to data.

Hooks still run before input insertion and retain their existing stop/context
behavior. A refusing hook can observe the current input without publishing it to
the conversation or sending it to a model. This ingress surface does not itself
mint MCP identities, persist audit records, or establish A8 lifecycle readiness.

### Verification runner summaries

Completion verification recognizes executed-test summaries from Vitest/Jest,
.NET, Bun, Node TAP and Rust libtest. Bun workspace prefixes (including nested
and sequential forms) are removed before parsing. Interleaved TAP streams stay
separate by workspace/script, and every TAP footer must be complete. Malformed,
duplicate or contradictory counters invalidate the evidence; aggregate totals
must use nonnegative safe integers and reconcile exactly.

Cancelled TAP cases count as failures; todo, pending, ignored, measured and
filtered-out cases remain visible as unexecuted/skipped obligations. File/suite
counts, individual test progress and a zero exit status are insufficient evidence.
Required test checks still reject zero totals, failures or skips. These rules do
not waive existing phase blockers or replace signed verification-map registration.

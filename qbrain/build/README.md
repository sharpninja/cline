# cline-qb build commands

The derivative keeps Cline's package scripts intact. Use these owned PowerShell
entrypoints for cline-qb verification. They run the existing TypeScript,
JavaScript, Bun and Node tools with explicit arguments; they do not convert the
application to another language.

Run from the repository root with Bun 1.4.2, Node 22 or newer, and PowerShell
available. Prepare dependencies with:

```powershell
pwsh -NoProfile -NonInteractive -File qbrain/build/Initialize-VscodeDependencies.ps1 `
  -ReceiptDirectory /path/to/new/dependency-receipt
```

This runs `bun install --frozen-lockfile --ignore-scripts`, then the installed
Node prebuilt-binary installers for `better-sqlite3` and `grpc-tools`. It checks
the unchanged lockfile and required native artifacts, stops on failure, and
disables source-build fallback. Installer-specific npm configuration is removed
only from native child environments; ordinary HTTP(S) proxy settings remain.
No root Husky lifecycle hook runs. SDK consumers require
`bun --shell=bun run build:sdk` after SDK source changes.

Prepare generated protocol sources once before verification:

```powershell
pwsh -NoProfile -NonInteractive -File qbrain/build/Invoke-VscodeBuild.ps1 `
  -Task prepare -ReceiptDirectory /path/to/new/preparation-receipt
```

Preparation retains source backups. If it changes tracked source, the runner
reports that review is required. Review and stage intentional generated changes
before verification. Generation never invokes the upstream `postprotos`
formatter. Use the separate `format:generated` task only when that write is
intended.

Invoke a verification task with a new receipt directory each time:

```powershell
pwsh -NoProfile -NonInteractive -File qbrain/build/Invoke-VscodeBuild.ps1 `
  -Task check-types -ReceiptDirectory /path/to/new/typecheck-receipt
```

Supported build tasks include `lint`, `format`, `build:webview`, `extension`,
`compile`, `compile-standalone`, `compile-tests`, `build:production`, `package`,
`ci:check-all` and `ci:build`. These consume prepared protocol output. `format`
checks formatting without writing. `-PlanOnly` prints the native command graph
without executing it.

Test tasks include `test:vitest`, `test:unit`, `test:bun`, `test:integration`,
`test:coverage`, `test:webview`, `test:webview:coverage`, `test:tp-orchestrator`,
`test:e2e`, `test:storage-startup` and `test:storage-webview`. Each keeps its
original suite selection. Storage tests exercise derivative isolation and must
not be pointed at real Cline user data.

CI adds its existing nonzero-test and retry checks through:

```powershell
pwsh -NoProfile -NonInteractive -File qbrain/build/Invoke-VscodeCiTests.ps1 `
  -Policy Vitest -ReceiptDirectory /path/to/new/ci-test-receipt
```

`Vitest` and `Unit` retain their original summary checks and native failure
codes. `IntegrationRetry` runs the existing integration task up to three times,
waiting five seconds between failed attempts. Each attempt has a separate
receipt; `output.log` preserves the test output. Missing or inconsistent child
receipts fail the wrapper. The PowerShell workflow commands preserve the
original selected-job checks, platform matrices and coverage paths. The
upstream ripgrep downloader still needs an owned replacement for its shell
invocation before that complete CI chain can pass the command-policy gate.

For a GUI test on Linux, use the owned display wrapper:

```powershell
pwsh -NoProfile -NonInteractive -File qbrain/build/Invoke-VscodeGui.ps1 `
  -Task test:e2e -ReceiptDirectory /path/to/new/e2e-receipt
```

It reuses an inherited `DISPLAY`, or starts Xvfb with a free display number and
stops only that owned process after the test. When it creates a display, it saves
that display's ownership receipt next to the command receipt. Inherited displays
currently have no separate display receipt. A test failure remains a failure
through the wrapper.

`dev` and `watch` preserve the native parallel Bun/TypeScript watcher commands.
Continuous output and cancellation behavior of the receipt runner still need
verification before the P1 exit gate. The workflow caller contract checks do
not establish that remote CI, all native prerequisites, or the full phase gate
have passed.

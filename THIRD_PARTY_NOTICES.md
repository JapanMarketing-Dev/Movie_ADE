# Third-party notices

Solocut includes code adapted from the projects below. Each ported file keeps its attribution in its header
comment ("Ported from Ferret …" / "Orca由来: …").

## Orca

- Source: https://github.com/stablyai/orca
- License: MIT. Copyright (c) 2026 Lovecast Inc.

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ferret

Ferret (MIT, Copyright (c) 2026 JapanMarketing-Dev, same organization as Solocut) is the intermediate source
for most ports: its files already adapt the Orca code listed below. The Ferret path is named in each Solocut file
header.

## Files ported from Orca (via Ferret)

| Solocut file | Orca source files |
|---|---|
| packages/agents/src/catalog.ts | src/shared/tui-agent-config.ts, src/shared/tui-agent-permissions.ts, src/renderer/src/lib/agent-catalog.tsx, src/shared/agent-process-recognition.ts, src/shared/agent-node-package-entrypoints.ts, src/shared/agent-node-entrypoint-identities.ts, README.md (Supported Agents list) |
| packages/agents/src/launch.ts | src/shared/tui-agent-startup-shell.ts, src/shared/tui-agent-launch-command.ts, src/shared/commit-message-prompt.ts, src/shared/powershell-native-argument.ts |
| packages/agents/src/install.ts | src/renderer/src/components/onboarding/OnboardingInlineCommandTerminal.tsx |
| apps/desktop/src/main/agentWorkspaceTrust.ts | src/main/claude/claude-folder-trust-file.ts, src/main/agent-trust-presets.ts, src/main/codex/config-toml-project-trust.ts, src/main/agent-workspace-trust.ts, src/main/agent-trust-write-deadline.ts |
| apps/desktop/src/renderer/src/styles/tokens.css | src/renderer/src/assets/main.css (colors), src/shared/terminal-themes/defaults.ts |
| apps/desktop/src/renderer/src/styles/ui.css | src/renderer/src/assets/main.css (shadows, focus rings), lucide sizing conventions |
| apps/desktop/src/renderer/src/styles/shell-ported.css | src/renderer/src/components/status-bar/StatusBarSurface.tsx, src/renderer/src/components/sidebar/ (sizes) |
| apps/desktop/src/renderer/src/shell/StatusBar.tsx | src/renderer/src/components/status-bar/StatusBarSurface.tsx, src/renderer/src/components/status-bar/StatusBar.tsx |
| apps/desktop/src/renderer/src/shell/Sidebar.tsx | src/renderer/src/components/sidebar/ |
| apps/desktop/src/renderer/src/shell/QuickOpen.tsx | src/renderer/src/components/quick-open-file-list.ts |
| apps/desktop/src/renderer/src/shell/search.ts | src/renderer/src/components/quick-open-file-list.ts |
| apps/desktop/src/renderer/src/shell/PaneTabs.tsx | src/renderer/src/components/tab-bar/ |
| apps/desktop/src/shared/usage.ts | src/shared/rate-limit-types.ts, src/shared/rate-limit-reset-format.ts, src/renderer/src/lib/window-label-formatter.ts, src/renderer/src/components/status-bar/tooltip.tsx, src/renderer/src/components/status-bar/UsageRosterPanel.tsx |
| apps/desktop/src/shared/accounts.ts | src/shared/managed-account-types.ts |
| apps/desktop/src/main/usage/credentials.ts | src/main/rate-limits/claude-oauth-credentials.ts, src/main/rate-limits/codex-backend-auth.ts |
| apps/desktop/src/main/terminal/shellStartup.ts | src/main/shell-templates.ts, src/main/zsh-startup-wrapper-builder.ts, src/main/pty/posix-shell-startup-command.ts, src/main/daemon/daemon-bash-shell-ready-rcfile.ts |
| apps/desktop/src/main/terminal/terminalHistory.ts | src/shared/terminal-tab-types.ts, src/main/daemon/ |
| apps/desktop/src/main/terminal/inheritedAgentEnv.ts | src/main/pty/pi-process-owner-env.ts, src/main/pty/terminal-color-env.ts |
| apps/desktop/src/main/terminal/processCwd.ts | src/main/providers/process-cwd.ts |
| apps/desktop/src/main/terminal/terminalEnv.ts | src/main/pty/appimage-terminal-env.ts |
| apps/desktop/src/main/platform/windowsSpawn.ts | src/shared/child-process/spawn-resolution.ts, src/shared/child-process/windows-cmd-shim-resolution.ts, src/shared/child-process/windows-command-line.ts |
| apps/desktop/src/main/agent/state.ts | src/shared/agent-title-core.ts |
| apps/desktop/src/renderer/src/components/TerminalPane.tsx | src/renderer/src/components/terminal-pane/terminal-shortcut-policy.ts, src/renderer/src/lib/pane-manager/pane-divider-drag.ts, src/renderer/src/lib/pane-manager/pane-divider.ts, src/shared/keybindings/definitions-core-4.ts |
| apps/desktop/src/renderer/src/components/QuickLaunchButton.tsx | src/renderer/src/components/tab-bar/QuickLaunchButton.tsx |
| apps/desktop/src/renderer/src/terminal/quickLaunchSearch.ts | src/renderer/src/components/tab-bar/TabBarCreateEntry.tsx, src/renderer/src/components/tab-bar/tab-create-entry-classifier.ts |
| apps/desktop/src/renderer/src/terminal/paneTree.ts | src/shared/terminal-tab-types.ts, src/renderer/src/lib/pane-manager/pane-tree-ops.ts, src/renderer/src/lib/pane-manager/pane-divider-drag.ts, src/renderer/src/lib/pane-manager/pane-manager-types.ts, src/shared/default-global-settings.ts, src/shared/constants.ts, src/renderer/src/components/tab-group/tab-drop-zone.ts |
| apps/desktop/src/renderer/src/terminal/restorePlan.ts | src/shared/terminal-tab-types.ts, src/main/ipc/pty/register-handlers.ts |
| apps/desktop/src/renderer/src/terminal/terminalOsc52.ts | src/renderer/src/components/terminal-pane/osc52-clipboard.ts |
| apps/desktop/src/renderer/src/terminal/terminalKeys.ts | src/renderer/src/components/terminal-pane/terminal-shortcut-policy.ts |
| apps/desktop/src/renderer/src/terminal/terminalContrast.ts | src/renderer/src/lib/terminal-contrast-correction.ts |
| apps/desktop/src/main/usage/fetchers.ts | src/main/rate-limits/claude-oauth-usage-request.ts, src/main/rate-limits/claude-oauth-usage-error.ts, src/main/rate-limits/claude-usage-window.ts, src/main/rate-limits/codex-backend-usage-client.ts, src/main/rate-limits/codex-rate-limit-window-classification.ts, src/main/rate-limits/codex-rate-limit-window-mapper.ts |
| apps/desktop/src/main/usage/policy.ts | src/main/rate-limits/service/service-types.ts, src/main/rate-limits/service/service-polling.ts, src/main/rate-limits/service/service-result-policy.ts, src/main/rate-limits/service/service-fetch-policy.ts |
| apps/desktop/src/main/usage/service.ts | src/main/rate-limits/service.ts, src/main/rate-limits/service/service-polling.ts, src/main/rate-limits/service/service-inactive-accounts.ts, src/main/rate-limits/claude-managed-account-usage.ts |
| apps/desktop/src/main/accounts/paths.ts | src/main/codex-accounts/codex-managed-home-path.ts, src/main/codex-accounts/host-codex-managed-home-ownership.ts, src/main/claude-accounts/managed-auth-path.ts |
| apps/desktop/src/main/accounts/env.ts | src/main/claude-accounts/environment.ts, src/main/codex-accounts/runtime-home-service-launch.ts |
| apps/desktop/src/main/accounts/identity.ts | src/main/codex-accounts/managed-codex-auth-readiness.ts, src/main/codex-accounts/codex-auth-identity.ts, src/main/claude-accounts/claude-auth-capture.ts, src/main/claude-accounts/keychain.ts |
| apps/desktop/src/main/accounts/agentConfig.ts | src/main/codex-accounts/codex-config-mirror.ts, src/main/codex/codex-daemon-socket-path-guard.ts |
| apps/desktop/src/main/accounts/service.ts | src/main/codex-accounts/service.ts, src/main/codex-accounts/codex-account-selection.ts, src/main/codex-accounts/codex-account-registration.ts, src/main/claude-accounts/claude-account-registration.ts |

## Files ported from Ferret (UI shell)

The renderer shell is ported from Ferret (`src/renderer/…`): `ui/*` (Button, Segmented, Tooltip, Modal, Toast, Badge,
Field → TextField, Row → ListRow, EmptyState, Progress, RecordButton, ErrorBoundary, IconTile), `shell/TitleBar.tsx`
(TitleBar), `shell/LayoutToggles.tsx`, `shell/ProjectMenu.tsx`, `shell/StatusBar.tsx` (StatusBar, StatusPopover),
`shell/Sidebar.tsx`, `shell/QuickOpen.tsx`, `shell/shortcut.ts` (lib/shortcut.ts), `settings/SettingsPage.tsx`,
`settings/settingsSections.ts`
(lib/settingsSections.ts), `onboarding/*` (onboarding/), and the styles `styles/fonts.css`, `styles/ui.css`,
`styles/shell-ported.css`, `styles/settings.css`.

# Mediator

**Personal AI-to-workspace bridge — TypeScript-first, local-first, fail-closed**

Mediator connects your existing browser AI conversation or official API connection (ChatGPT, Gemini, Claude, DeepSeek) to your local coding workspace in Antigravity IDE or VS Code. It applies changes only to a shadow staging copy, shows you a file-by-file diff, and lets you approve before anything touches your real project.

---

## What it does

- 🔗 **Dual Connection Modes**:
  - **Mode A (Browser Session Bridge)**: Attaches to your active web conversation tab in Chrome/Edge (Gemini, ChatGPT, or manual handoff for Claude/DeepSeek) — zero API key required.
  - **Mode B (Official API Connection)**: Direct, authenticated API integration with OpenAI, Google Gemini, Anthropic Claude, and DeepSeek with streaming SSE, usage tracking, and cost calculation.
- 📋 **Extracts AI proposals** — validates them against a typed protocol envelope (`<<<MEDIATOR_PLAN>>>`)
- 🧱 **Stages changes in a shadow copy** — your live workspace is never touched without approval
- 🔍 **Shows diffs + warnings** — protected paths, conflict alerts, risk level
- ✅ **Requires your approval** — approve once, deny, pause, stop, or rollback
- 📤 **Sends sanitized results back to the AI** — maintains loop context
- 🔒 **Never runs arbitrary commands** — Review-only by default (`NO-GO-AUTOEXEC`); execution requires a proven sandbox
- 🛡️ **Encrypted Credential Storage** — API keys are encrypted at rest with AES-256-GCM; zero plaintext secret exposure in logs or debug dumps

---

## Multi-Provider Support Matrix

| Provider | Canonical ID | Mode A (Browser Bridge) | Mode B (Official API) | Supported Models | Authentication | Reasoning Separation |
|---|---|---|---|---|---|---|
| **OpenAI ChatGPT** | `openai` | Full DOM Bridge (chatgpt.com) | Official Chat Completions API | `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini` | `Bearer <api-key>` | Standard |
| **Google Gemini** | `gemini` | Full DOM Bridge (gemini.google.com) | Official REST API | `gemini-1.5-pro`, `gemini-1.5-flash`, `gemini-2.0-flash` | `x-goog-api-key: <key>` | Standard |
| **Anthropic Claude** | `claude` | Manual Copy/Paste Bridge | Official Messages API | `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229` | `x-api-key: <key>` | Standard |
| **DeepSeek** | `deepseek` | Manual Copy/Paste Bridge | Official Chat Completions API | `deepseek-chat`, `deepseek-reasoner` | `Bearer <api-key>` | Isolated (`reasoning_content` strictly isolated) |

---

## Current status

**Multi-Provider Release — Personal Use (S29–S32 Completed)**. See `docs/SPRINT_STATUS.md` and `docs/PROVIDER_CAPABILITY_MATRIX.md`.

- Full pair-programming workflow across all four providers.
- Bounded switching between Mode A and Mode B; switching is strictly blocked while active operations, staging transactions, or review requests are pending (`PROVIDER_SWITCH_NOT_ALLOWED_WHILE_ACTIVE`).
- Automatic command execution is disabled fail-closed under `NO-GO-AUTOEXEC` (ADR-002, ADR-017, ADR-021, ADR-022). All recipes provide copyable CLI instructions for manual terminal execution.
- Windows 11 current-user installation and uninstallation: see [Windows Installation Guide](docs/INSTALL_WINDOWS.md).

---

## Architecture

TypeScript monorepo with strict module boundaries. See `docs/ARCHITECTURE.md` and `docs/ADR/ADR-022-unified-four-provider-architecture.md`.

```
apps/browser-extension     # Provider page observation, content scripts, manual send
apps/ide-extension         # Diff panel, multi-provider settings, approvals, status
apps/cli                   # start/stop/status
packages/provider-core     # Canonical registry, AES-256-GCM credential store, 4 API adapters
packages/shared-contracts  # Canonical provider IDs, error codes, Result types
packages/                  # Bounded modules (policy, staging, persistence, context-engine, etc.)
```

---

## Getting started (development)

```powershell
# Requires Node.js >= 20 and npm >= 10
npm install
npm run build
npm run test
npm run typecheck
npm run lint
```

---

## Security & Privacy

See `SECURITY.md`, `docs/THREAT_MODEL.md`, and `docs/ADR/ADR-022-unified-four-provider-architecture.md`.

- **Review-Only V1**: No automated code execution or live workspace mutation without human review.
- **Credential Protection**: Stored in `%LOCALAPPDATA%\Mediator\credentials.enc` using AES-256-GCM encryption with machine-derived keys.
- **DeepSeek Reasoning Privacy**: `deepseek-reasoner` reasoning chains are strictly isolated from normal prompt response content to avoid leaking CoT reasoning into workspace payloads or stream chunks.
- **SSRF & Network Defenses**: Mode B connects exclusively to official HTTPS endpoints over TLS. Mode A web research uses strict domain allowlisting and private IP blocking.
- **Local-First**: Zero cloud telemetry, zero remote tracking. All data is kept local on the workstation.

---

## License

Personal use. Not yet released publicly. Do not publish until permissions and privacy are documented per `docs/SPRINT_STATUS.md`.

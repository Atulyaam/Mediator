# Sprint Status

- **Master spec:** Mediator_Final_Development_Plan_v1.3.md
- **Sprint plan:** Mediator_Sprint_Wise_Development_Plan_v1.3.md
- **Current sprint:** S05 — Path Containment & Windows Path Security
- **Status:** PASS
- **Provider:** Google Gemini (gemini.google.com)
- **IDE:** Antigravity IDE on Windows 11
- **OS:** Windows 11
- **Node.js:** v24.13.0
- **npm:** 11.6.2
- **Git:** 2.46.0.windows.1
- **Execution GO/NO-GO:** NO-GO-AUTOEXEC → **Review-only V1** (ADR-002)

---

## S05 Exit Gate Checklist

| Item | Status | Evidence |
|---|---|---|
| Single authoritative path containment API | ✅ PASS | `validateContainedPath()` in `packages/workspace-boundary/src/pathContainment.ts` |
| Requires confirmed and resolved workspace root | ✅ PASS | Returns `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_CONFIRMATION_DENIED`, `WORKSPACE_UNAVAILABLE`, `WORKSPACE_UNRESOLVED` |
| Parent directory traversal (`../`) rejected | ✅ PASS | Tests 3, 3b, 3c in `pathContainment.test.ts` verify `PATH_TRAVERSAL` |
| Outside absolute paths rejected | ✅ PASS | Tests 4, 4b in `pathContainment.test.ts` verify `PATH_OUTSIDE_ROOT` |
| Sibling directory prefix attack prevented | ✅ PASS | Test 5 (`C:\project-evil` vs `C:\project`) verifies non-prefix match |
| Outside-pointing symlinks and junctions denied | ✅ PASS | Tests 6, 6b in `pathContainment.test.ts` verify `PATH_SYMLINK_ESCAPE` via `realpathSync` |
| In-root symlinks permitted safely | ✅ PASS | Test 7 verifies in-root symlinks targeting inside canonical root succeed |
| Non-existent targets with safe parent handled | ✅ PASS | Test 8 verifies safe ancestor projection with `exists: false` |
| Non-existent targets with unsafe parent denied | ✅ PASS | Test 9 verifies ancestor resolving outside root returns `PATH_SYMLINK_ESCAPE` |
| Reserved device names rejected | ✅ PASS | Test 10a verifies `CON`, `NUL`, `AUX`, `PRN`, `COM1-9`, `LPT1-9` yield `PATH_RESERVED_DEVICE` |
| Alternate Data Streams (ADS) rejected | ✅ PASS | Test 10b verifies `:` syntax yields `PATH_ALTERNATE_DATA_STREAM` |
| Trailing dots, spaces & illegal Win32 chars denied | ✅ PASS | Test 10c verifies malformed paths yield `PATH_MALFORMED` |
| Case-insensitive Windows path comparisons | ✅ PASS | Test 11 verifies lowercase/uppercase paths match canonical root |
| UNC and extended-length fail closed | ✅ PASS | Test 12 verifies `\\server\share` yields `PATH_OUTSIDE_ROOT` |
| TOCTOU race detection & safe I/O wrappers | ✅ PASS | `revalidateContainedPath()`, `safeReadProjectFile()`, `safeWriteProjectFile()`, `safeDeleteProjectFile()` |
| CLI `--target` validation integration | ✅ PASS | `mediator workspace --workspace <path> --confirm --target <file>` verifies containment directly |
| Existing S01–S04 behavior intact | ✅ PASS | All 121 earlier tests + 34 S05 tests = **155 / 155 tests passing** |

---

## Commands and tests actually run

| Command | Exit code | Result | Evidence |
|---|---:|---|---|
| `npm run lint` | 0 | 0 errors, 0 warnings across all `.ts` files in all 6 workspaces | stdout |
| `npm run typecheck` | 0 | All 6 workspaces typechecked cleanly (0 errors) | stdout |
| `npm run build` | 0 | All 6 workspaces built cleanly (`tsc -p tsconfig.json`) | stdout |
| `npm test` | 0 | **155 / 155 unit tests passed** (5 test files: 34 pathContainment, 42 workspace-boundary, 43 task-domain, 18 mediatorState, 18 contracts/coord) | stdout |
| `node apps/cli/dist/index.js workspace --workspace . --confirm --target package.json` | 0 | Valid target confirmed: `CONTAINED`, `Exists: YES` | stdout |
| `node apps/cli/dist/index.js workspace --workspace . --confirm --target ../outside.txt` | 1 | Traversal denied: `PATH_TRAVERSAL` | stdout |
| `node apps/cli/dist/index.js workspace --workspace . --confirm --target ../Mediator-evil/secret.txt` | 1 | Sibling prefix attack denied: `PATH_TRAVERSAL` | stdout |
| `node apps/cli/dist/index.js workspace --workspace . --confirm --target con.txt` | 1 | Reserved device denied: `PATH_RESERVED_DEVICE` | stdout |
| `node apps/cli/dist/index.js workspace --workspace . --confirm --target package.json:hidden` | 1 | ADS denied: `PATH_ALTERNATE_DATA_STREAM` | stdout |
| `node apps/cli/dist/index.js workspace --workspace . --target package.json` | 1 | Unconfirmed root denied: `WORKSPACE_CONFIRMATION_REQUIRED` | stdout |

---

## Containment Strategy & Security Defenses

1. **Root Gating:** Verification begins by checking `checkWorkspacePermittedForFileOps()`. Unconfirmed, denied, missing, or unresolved roots immediately block file validation without inspecting target paths.
2. **Lexical Boundary Enforcement:**
   - Traversal tokens (`../`, `..\\`) and outside absolute drive paths are resolved and evaluated against `canonicalRoot`.
   - **Prefix Collision Defense:** Boundary containment explicitly verifies `candidate === root || candidate.startsWith(root + path.sep)`. Simple substring checks (`startsWith(root)`) that would allow `C:\project-evil` inside `C:\project` are strictly prevented.
3. **Physical Filesystem Resolution:**
   - For existing files, `realpathSync` resolves all intermediate symlinks, directory junctions, and reparse points. The resolved canonical target is tested against `canonicalRoot`.
   - For new (non-existent) files, the closest existing ancestor directory is located and its `realpathSync` verified. If any ancestor resolves outside the root, the path is denied with `PATH_SYMLINK_ESCAPE`.
4. **Windows Edge-Case Classification:**
   - **Alternate Data Streams:** Any `:` (except index 1 of a leading drive letter `C:`) is classified as `PATH_ALTERNATE_DATA_STREAM`.
   - **Reserved Device Names:** Checked against `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` (and extensions such as `CON.txt`, `NUL.json`) across every path component.
   - **Trailing Dots / Spaces:** Rejected with `PATH_MALFORMED` because Win32 automatically strips trailing dots and spaces, which could create unintended collisions.
   - **Case-Insensitive Windows Semantics:** Path comparison normalizes drive letters to uppercase and performs case-insensitive comparisons while preserving NFC Unicode normalization.
5. **TOCTOU Reduction:**
   - `revalidateContainedPath()` re-checks identity immediately before operations.
   - `safeReadProjectFile()`, `safeWriteProjectFile()`, and `safeDeleteProjectFile()` verify containment, perform the operation, and re-verify that the physical realpath remained strictly within `canonicalRoot`.

---

## Windows-Specific Limitations & Known Risks

- **Win32 Reparse Point Attributes:** Deep reparse point tag queries (such as detecting whether a reparse point is a OneDrive cloud placeholder vs a directory junction) rely on `fs.realpathSync.native` delta and OneDrive directory heuristics. Windows APIs like `GetFileAttributesW` with `FILE_ATTRIBUTE_REPARSE_POINT` are not directly exposed in standard Node.js without native C++ add-ons. Where physical target resolution cannot be proven, the safety status remains `unknown` or fails closed.
- **Short Name (8.3) Aliases:** On volumes with 8.3 generation enabled, short names (e.g. `PROGRA~1`) are canonicalized to their long names by `fs.realpathSync.native`. If an 8.3 alias references an outside path, `realpathSync` resolves it outside and `validateContainedPath` denies it.
- **Symlink Creation Privileges:** Creating symlinks on Windows without Developer Mode enabled requires administrative privileges (`SeCreateSymbolicLinkPrivilege`). Real OS symlink tests conditionally run if privileged; mock adapter tests guarantee 100% deterministic test coverage across all environments.

---

## Changed / Added files in S05

- `packages/shared-contracts/src/index.ts` (added `ContainedPath` and `FileOperationType` interfaces)
- `packages/workspace-boundary/src/pathContainment.ts` (new core path containment, Windows security classifiers, and safe I/O wrappers)
- `packages/workspace-boundary/src/pathContainment.test.ts` (new 34 unit tests covering all 15 S05 requirements)
- `packages/workspace-boundary/src/index.ts` (enhanced `FileSystemAdapter`, re-exported S05 APIs)
- `apps/cli/src/index.ts` (added `-t, --target <path>` option to `mediator workspace` command for authoritative containment checks)
- `docs/SPRINT_STATUS.md` (updated with S05 verification evidence)

---

## Decisions / ADRs

- **ADR-001:** Google Gemini selected as first provider
- **ADR-002:** Review-only mode for V1 — no automatic command execution
- **ADR-003:** Canonical workspace resolution requires separate tracking of `selectedPath` vs `canonicalPath`, explicit confirmation gating, and auto-invalidation on path alteration.
- **ADR-004:** Path containment is enforced via a single authoritative API (`validateContainedPath`), combining lexical prefix defense (`root + path.sep`), physical `realpathSync` resolution, ancestor validation for non-existent targets, and Windows edge-case classifiers.

---

## Next sprint

**S06 — Secret scanner + context filter**

Dependencies: S05 ✅  
Goal: Stop credentials and sensitive tokens from reaching the web AI, ordinary logs, diagnostics, or debug bundles. Implement baseline patterns (`.env*`, `*.pem`, `*.key`, `id_rsa`, `.ssh/`, `.aws/`, credentials, etc.), `.mediatorignore` support for context collection, redaction in all outputs, and synthetic secret fixture tests.

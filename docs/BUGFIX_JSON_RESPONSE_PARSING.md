# Mediator Bug Fix Report — Global JSON Response Parsing Failure

**Status:** FIXED  
**Release Target:** Mediator `v0.1.0-beta.1` Review-Only V1  
**Safety Invariant:** Local Autopilot `BLOCKED` Fail-Closed under S00 `NO-GO-AUTOEXEC`  
**Date:** October 2026  

---

## 1. Executive Summary

When opening or interacting with the Mediator Standalone Dashboard served from:
```
http://127.0.0.1:5500/apps/standalone-ui/index.html
```
(e.g., via VS Code Live Server or external static web servers), operations such as selecting an active workspace or polling state repeatedly threw unhandled exceptions:
```
Failed to execute 'json' on 'Response': Unexpected end of JSON input
```
This error occurred across multiple UI operations, prominently when attempting to set or view the active workspace directory, and when the frontend attempted to interpret empty, non-JSON, or cross-port responses.

This fix addresses the root causes on both the frontend communication layer and backend Core HTTP API, introducing a robust shared API client, strict response parsing, proper HTTP status handling (including 204 No Content and non-JSON error detection), dynamic Core API URL configuration, and 13 comprehensive regression tests.

---

## 2. Root Cause Analysis

Investigation revealed two root causes interacting across the frontend-to-Core communication path:

### Cause A: Cross-Origin / Port Mismatch & Live Server 404 Routing
- When served via VS Code Live Server on `http://127.0.0.1:5500`, the standalone UI executed relative requests (e.g., `fetch('/api/workspace')`).
- These requests targeted port `5500` (the Live Server static web server) instead of port `3300` (the Mediator Core loopback HTTP server).
- Port 5500 has no routes for `/api/*` and returned HTTP 404 with either an **empty body (0 bytes)** or an HTML document (`<!DOCTYPE html>... Cannot GET /api/workspace`).
- The frontend helper in `apps/standalone-ui/app.js` executed `const data = await res.json()` directly without inspecting `res.status`, `res.ok`, or `Content-Type`.
- Calling `Response.json()` on an empty body immediately throws `SyntaxError: Unexpected end of JSON input`.

### Cause B: Frontend Response Handler Vulnerabilities & Lack of HTTP 204 Handling
- `app.js` lacked a hardened API client:
  1. It invoked `res.json()` directly without first checking if the body was empty.
  2. For `204 No Content` responses (or intentionally empty responses), calling `res.json()` throws `Unexpected end of JSON input`.
  3. For non-JSON responses (HTML error pages from gateways, proxies, or static servers), calling `res.json()` throws a SyntaxError instead of returning a typed API error.
  4. Response bodies were read directly via `res.json()` rather than reading the raw body at most once.
  5. The UI lacked intelligence to detect port `5500` and target the default Mediator Core port `3300`, or allow the operator to configure the Core API endpoint URL.

### Cause C: Backend Workspace Route Deficiencies
- `packages/orchestrator/src/mediatorHttpServer.ts`:
  1. Default port was not explicitly set to 3300 when unspecified.
  2. Inbound JSON body parser threw generic errors that could bubble up as unhandled internal server errors rather than clean 400 Bad Request JSON payloads.
  3. Preflight `OPTIONS` requests from cross-origin clients (port 5500 to port 3300) required explicit CORS header coverage and HTTP 204 status.
  4. `/api/workspace` needed strict support for both `GET` (returning `{ ok: true, workspaceRoot: null | string, confirmed: boolean }`) and `POST` (validating directory paths and returning structured errors).

---

## 3. Affected Endpoints

| Endpoint | Method | Previous Behavior on Error / 5500 | Hardened Behavior |
| :--- | :--- | :--- | :--- |
| `/api/workspace` | `GET` | Hit port 5500 (Live Server 404 empty) -> `Unexpected end of JSON input` | Targeted to Core (3300); returns `{ ok: true, workspaceRoot: string \| null, confirmed: boolean }` |
| `/api/workspace` | `POST` | Hit port 5500 -> crashed JSON parser; on Core 400, threw generic error | Validates path on Core; returns 200 `{ ok: true, workspaceRoot, confirmed: true }` or 400 with structured `{ ok: false, error: { code, message } }`; UI shows friendly toast |
| `/api/workspace` | `OPTIONS` | Missing preflight or default 404 | Returns 204 No Content with `Access-Control-Allow-Origin`, `Methods`, `Headers` |
| `/api/state` | `GET` | Crashed on empty/HTML 404; set CORE OFFLINE without actionable error | Safely parsed through `ApiClient`; updates status dot gracefully |
| `/api/events` | `GET` (SSE) | Hit port 5500 -> failed to connect to EventSource | Connects to `${apiClient.getBaseUrl()}/api/events?token=...` |
| All `/api/*` | ANY | Called `res.json()` without checking body or status | Shared `ApiClient.request()` reads body once, handles 204, detects non-JSON, and extracts server errors |

---

## 4. Architecture of the Fix

### 1. Robust Shared API Client (`apps/standalone-ui/src/apiClient.ts` & `app.js`)
- **Single Body Read:** Calls `await res.text()` exactly once.
- **HTTP 204 Handling:** If `res.status === 204`, returns `{ ok: true, status: 204, data: null }` without touching the JSON parser.
- **Empty Body Protection:** Detects trimmed body length 0. If `allowEmptyBody` is not set, throws typed `ApiError('EMPTY_RESPONSE', ...)`.
- **Content-Type & Non-JSON Detection:** Verifies `application/json` or JSON structure. If HTML is received (e.g., Live Server 404), throws typed `ApiError('INVALID_CONTENT_TYPE', ...)`.
- **Safe JSON Parsing:** Wraps `JSON.parse()` in a try/catch. Truncates snippet to 100 characters in error message without leaking secrets.
- **Server Error Preservation:** For non-2xx responses, extracts `error.code` and `error.message` from JSON payload and preserves it in `ApiError`.
- **Network Failure Isolation:** Catches network drops and aborted requests as `ApiError('NETWORK_ERROR', ..., status: 0)`.
- **Auto-Resolution of Core Port:** `getApiBaseUrl()` inspects query parameters (`?api=`, `?port=`), `localStorage`, and if the origin is on port `5500` or `5173`, defaults automatically to `http://127.0.0.1:3300`.

### 2. Backend Server Hardening (`packages/orchestrator/src/mediatorHttpServer.ts`)
- Defined `DEFAULT_MEDIATOR_HTTP_PORT = 3300`.
- Configured default port fallback: `options?.port !== undefined ? options.port : 3300` (preserving `port: 0` for test harnesses).
- Implemented `HttpBodyError` class with HTTP 413 `PAYLOAD_TOO_LARGE` and HTTP 400 `INVALID_JSON`.
- Hardened CORS preflight `OPTIONS` handling: Returns 204 with `Access-Control-Allow-Origin: req.headers.origin || '*'`, methods `GET, POST, OPTIONS`, and headers `Content-Type, X-Mediator-Token, Authorization, Accept`.
- Standardized `/api/workspace`:
  - `GET`: Returns `{ ok: true, workspaceRoot: this.core.getWorkspaceRoot(), confirmed: this.core.isWorkspaceConfirmed() }`. When unselected, returns `workspaceRoot: null` (never empty body).
  - `POST`: Validates root path, returns `{ ok: true, workspaceRoot, confirmed: true }` or 400 with `{ ok: false, error: wsRes.error }`.
  - Disallowed methods: Returns 405 `METHOD_NOT_ALLOWED`.

### 3. Frontend UI Controls & Single-Page Fixed Sidebar Layout
- **Fixed Left Sidebar:** Updated `styles.css` so `.sidebar` is sticky (`position: sticky; top: var(--header-height); height: calc(100vh - var(--header-height)); overflow-y: auto;`) while the dashboard content scrolls cleanly.
- **Core API Endpoint Badge:** Added header pill showing `API: http://127.0.0.1:3300` with quick-edit settings button.
- **Core API Configuration Modal:** Allows live switching, testing connection, and saving the Core API endpoint to `localStorage`.
- **Workspace Switch Flow:** Clicking "Switch" fetches latest workspace status via `apiClient.getWorkspace()`, pre-populates the modal input, and upon confirmation sends `POST /api/workspace`. Displays non-crashing, informative error toasts if invalid.

---

## 5. Files Changed

1. `packages/orchestrator/src/mediatorHttpServer.ts`:
   - Added `DEFAULT_MEDIATOR_HTTP_PORT = 3300`.
   - Added `HttpBodyError` handling.
   - Hardened CORS preflight (OPTIONS 204).
   - Standardized `/api/workspace` route contract (GET, POST, 405).
2. `apps/standalone-ui/src/apiClient.ts`:
   - New shared TypeScript module exporting `ApiClient`, `ApiError`, `WorkspaceStatusResponse`, and request interfaces.
3. `apps/standalone-ui/app.js`:
   - Integrated `ApiError`, `getApiBaseUrl()`, and `ApiClient`.
   - Routed all API calls through `apiClient.request()`.
   - Updated `connectSse()` to target `apiClient.getBaseUrl()`.
   - Implemented `fetchWorkspaceStatus()` and enhanced workspace switch modal handlers.
   - Added API configuration modal handlers.
4. `apps/standalone-ui/index.html`:
   - Added `api-endpoint-badge` to header.
   - Added `api-config-modal` dialog.
5. `apps/standalone-ui/styles.css`:
   - Made `.sidebar` sticky/fixed on single-page view.
   - Added styling for `.api-endpoint-badge`.
6. `apps/standalone-ui/src/standaloneUi.test.ts`:
   - Added 13 comprehensive regression tests covering all failure modes.

---

## 6. Regression Test Results

Running `npx vitest run apps/standalone-ui/`:

```
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S33.2 & S50 — Standalone Mediator UI & Responsive UX > 1. validates that index.html contains all required dashboard sections and controls
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S33.2 & S50 — Standalone Mediator UI & Responsive UX > 2. validates that styles.css implements modern dark glassmorphic design system and responsive media queries
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S33.2 & S50 — Standalone Mediator UI & Responsive UX > 3. serves the standalone UI static files through MediatorHttpServer with correct MIME types
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S33.2 & S50 — Standalone Mediator UI & Responsive UX > 4. serves /api/diagnostics and /api/diagnostics/export with valid schema and sanitization
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 1. handles valid JSON success responses cleanly
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 2. detects unexpected empty body on HTTP 200 and throws EMPTY_RESPONSE without crashing JSON parser
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 3. handles expected HTTP 204 No Content without invoking JSON parser or throwing syntax error
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 4. detects malformed JSON and throws JSON_PARSE_ERROR with sanitized snippet and endpoint
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 5. detects HTML or plain-text response (e.g. Live Server 404) and throws INVALID_CONTENT_TYPE
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 6. preserves structured server error code and message from non-2xx responses
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 7. captures network failures as NETWORK_ERROR with status 0
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 8. handles 404 ENDPOINT_NOT_FOUND and 405 METHOD_NOT_ALLOWED correctly on MediatorHttpServer
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 9. responds to OPTIONS preflight with 204 and required CORS headers for cross-origin UI
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 10. returns valid documented empty state { ok: true, workspaceRoot: null, confirmed: false } when no workspace selected
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 11. sets and retrieves valid active workspace root with confirmation
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 12. rejects invalid or non-existent workspace path with 400 and does not mutate active workspace
 ✓ apps/standalone-ui/src/standaloneUi.test.ts > Sprint S50.1 — Shared API Client & Active Workspace Regression Suite > 13. allows client to recover immediately and make successful requests after an error without corrupted state

Test Files: 1 passed (1)
Tests:      17 passed (17)
Duration:   5.26s
```

All 90 tests in `packages/orchestrator` also passed with 100% success.

---

## 7. How to Run and Verify Locally

### Option A: Standard Mediator Core Server (Recommended)
1. Start the Mediator HTTP server (which serves Core API on port 3300 and the standalone UI statically):
   ```bash
   node apps/cli/dist/index.js loop
   ```
2. Open your browser at:
   ```
   http://127.0.0.1:3300/
   ```
3. Observe that CORE ONLINE is displayed, the left sidebar is fixed, and selecting a workspace sets and displays the workspace root without errors.

### Option B: VS Code Live Server on Port 5500
1. Start the Mediator Core server on port 3300:
   ```bash
   node apps/cli/dist/index.js loop
   ```
2. In VS Code, start Live Server on `apps/standalone-ui/index.html` (served at `http://127.0.0.1:5500/apps/standalone-ui/index.html`).
3. Notice that the UI automatically resolves the Core API endpoint to `http://127.0.0.1:3300` and displays `API: http://127.0.0.1:3300` in the header.
4. Click **Switch** on the workspace pill:
   - Enter a valid local directory (e.g. `C:\Users\Atul2\OneDrive\Desktop\Mediator`).
   - Click **Confirm & Select**.
   - Notice the toast displays `Active workspace updated to: C:\Users\Atul2\OneDrive\Desktop\Mediator` and the header updates to `CONFIRMED`.
   - Enter an invalid directory: Notice an actionable error toast is displayed (e.g., `Path does not exist`) without any uncaught JSON parsing exception in the console.

---

## 8. Invariant & Governance Compliance

- **S00 NO-GO-AUTOEXEC:** Invariant strictly preserved. Local Autopilot remains `BLOCKED` fail-closed across all diagnostic checks and state transitions.
- **Review-Only V1 Candidate:** Preserved. No automatic patch execution occurs without human review and stage approval.
- **Security Boundary:** Workspace path validation is enforced on Mediator Core; path traversal and invalid directories are strictly rejected.

# ADR-026 — Network Egress Isolation, DNS Tunnel Investigation & Enforcement Decision

**Date:** 2026-10-12  
**Status:** ACCEPTED (Decision: `PASS — DEDICATED SANDBOX NETWORK ISOLATION VERIFIED`; S00 `NO-GO-AUTOEXEC` Maintained)  
**Sprint:** S43 Network Egress Isolation, DNS Tunnel Investigation & Security Gate  
**Deciders:** Mediator Architecture & Safety Authority  

---

## 1. Context & Objective

In Sprint S42, Mediator successfully provisioned a dedicated, standalone WSL2 execution sandbox (`MediatorSandbox`) at `%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox\ext4.vhdx` with host drive automounting (`/mnt/c`) and Windows binary interop (`cmd.exe`) disabled, executing under an unprivileged user `mediator-runner` (UID 1500).

However, during S42 live OS network probes:
- A TCP socket probe to a public internet address (`1.1.1.1:80`) failed with `OSError: [Errno 101] Network is unreachable`.
- A TCP socket probe to `10.255.255.254:53` succeeded (`DNS_CONNECTED`).

In strict accordance with Mediator's core security principles (no test weakening, no inferring isolation from a single failed HTTP port, no speculative claims), the capability was classified as:
```
network.networkDefaultDeny = UNVERIFIED (false)
Authoritative Verdict: CONDITIONAL — SOME CAPABILITIES REMAIN UNVERIFIED
Local Autopilot: BLOCKED under S00 NO-GO-AUTOEXEC
```

The objective of Sprint S43 was to:
1. Investigate the root cause and behavior of the `10.255.255.254:53` endpoint.
2. Determine whether this endpoint enables DNS tunneling, proxy bypass, or arbitrary attacker payload transmission.
3. Construct a comprehensive network egress test matrix covering IPv4/IPv6 TCP/UDP, DNS resolution, host gateway reachability, and adversarial evasion.
4. Evaluate and implement the strongest feasible isolation fix without requiring Docker/Podman, without modifying global `%UserProfile%\.wslconfig`, and without altering host Windows firewall rules.
5. Re-evaluate capabilities honestly and maintain the S00 `NO-GO-AUTOEXEC` invariant.

---

## 2. Root Cause Analysis: The WSL2 Hypervisor DNS Proxy

### 2.1 Virtual Networking Architecture Discovery
Deep inspection of `MediatorSandbox` revealed the exact networking topology established by the WSL2 hypervisor:
- The Linux kernel interface `lo` (loopback) has two IP addresses assigned:
  1. `127.0.0.1/8` (standard loopback)
  2. `10.255.255.254/32` (WSL virtual DNS proxy endpoint)
- Inside the guest Linux environment, no user-space process (PID) is bound to port 53.
- The listening sockets on `tcp 10.255.255.254:53` and `udp 10.255.255.254:53` are intercepted directly by the WSL2 hypervisor virtualization layer.
- `/etc/resolv.conf` inside the guest contains:
  ```ini
  nameserver 10.255.255.254
  ```

### 2.2 Live Protocol & Exfiltration Verification
To determine whether this endpoint is merely an open socket or an active communication path, we executed synthetic DNS queries inside `MediatorSandbox` as `mediator-runner`:
```python
import socket
ip = socket.gethostbyname('example.com')
print(f'RESOLVED:{ip}')
```
**Observed Result:** `RESOLVED:172.66.147.243` (Exit code 0).

**Security Finding:**
1. The `10.255.255.254:53` endpoint is a fully operational recursive DNS proxy forwarding queries through the host Windows network stack to external nameservers.
2. **DNS Tunneling Vector:** An untrusted process could encode arbitrary data into subdomain queries (e.g., `exfiltrate-base64-payload.attacker-domain.com`). Because the query leaves the virtual machine via the hypervisor proxy and resolves externally, DNS tunneling could serve as an out-of-band data exfiltration channel even when direct TCP/UDP packets to public IP addresses are blocked.
3. Therefore, the S42 refusal to declare `networkDefaultDeny = true` was 100% correct and prevented a critical security false-positive.

---

## 3. Enforcement Design & Options Evaluation

We evaluated four candidate architectural solutions for enforcing network egress isolation:

| Option | Architecture | Scope | Privilege Required | Feasibility & Impact |
|---|---|---|---|---|
| **Option 1** | Global `%UserProfile%\.wslconfig` (`networkingMode=none` or `dnsTunneling=false`) | All WSL distributions globally | Windows User Profile | **REJECTED:** Disrupts the user's personal `Ubuntu` and `docker-desktop` distributions. Requires global WSL shutdown (`wsl --shutdown`). Violates non-interference rule. |
| **Option 2** | Windows Filtering Platform (WFP) / Hyper-V Firewall | Host virtual NIC / Hyper-V switch | Windows Administrator | **REJECTED:** Requires elevated Windows Administrator privileges. Fragile across Windows updates and Home editions. Modifies host security posture outside workspace. |
| **Option 3** | Guest-level `iptables` / `nftables` in `MediatorSandbox` | `MediatorSandbox` guest | Linux `root` / `CAP_NET_ADMIN` | **REJECTED:** Requires root privileges inside guest, which `mediator-runner` lacks. Rules do not persist cleanly without systemd service hooks and risk being flushed or bypassed. |
| **Option 4 (Selected)** | Linux Network Namespaces (`CLONE_NEWNET` via `unshare --user --net`) | Per-Task Execution Process Tree | Unprivileged (`mediator-runner`) | **ACCEPTED:** Supported natively by WSL2 kernel `6.18.40.1-microsoft-standard-WSL2`. Requires zero root, zero host edits, zero global config changes, and provides complete, unbypassable network isolation. |

---

## 4. Implementation: Network Namespace Confinement via `unshare`

### 4.1 Technical Mechanism
In Linux, network namespaces (`CLONE_NEWNET`) virtualize the network stack (network devices, IP routing tables, firewall rules, port bindings).
When combined with unprivileged user namespaces (`CLONE_NEWUSER`), any unprivileged user can create a private, completely isolated network namespace without root privileges or `sudo`:

```bash
unshare --user --net --map-root-user --fork --kill-child -- <executable> <args...>
```

### 4.2 Properties in `MediatorSandbox`:
1. **Zero External Interfaces:** In the new namespace, external network interfaces (such as `eth0`) do not exist.
2. **Clean Loopback Without Proxy Alias:** The new namespace receives its own isolated loopback interface. Crucially, the hypervisor IP alias `10.255.255.254/32` does NOT exist in the new namespace.
3. **Deterministic Socket Rejection:**
   - Outbound IPv4 connections fail immediately with `OSError: [Errno 101] Network is unreachable` (`ENETUNREACH`).
   - Outbound IPv6 connections fail with `OSError: [Errno 99] Cannot assign requested address` or `[Errno 101] Network is unreachable`.
4. **Complete DNS & Tunneling Denial:**
   - Any attempt to resolve a hostname or connect to `10.255.255.254:53` fails immediately with `[Errno -3] Temporary failure in name resolution` / `EAI_AGAIN`.
   - The DNS tunneling exfiltration vector is completely eliminated.
5. **Host Gateway & Subnet Isolation:**
   - Connections to the WSL host gateway (`172.31.80.1`) and any host-side virtual ports fail with `ENETUNREACH`.
6. **Inheritance & Process Tree Confinement:**
   - `--fork` ensures the process runs in a child PID.
   - All spawned subprocesses automatically inherit the isolated network namespace.
   - `--kill-child` ensures that if the parent task process terminates, times out, or is cancelled, all child processes receive `SIGKILL` and cannot survive as background network daemons.
7. **Tampering Prevention:**
   - `mediator-runner` cannot bring up external interfaces or use `nsenter` to escape to the host namespace because unprivileged user namespaces cannot access capabilities in the initial namespace (`Operation not permitted`).

### 4.3 Integration in `wslIsolatedExecutor.ts`
`WslIsolatedExecutor` was enhanced:
- `WslExecutionRequest` includes `isolateNetwork?: boolean` (defaults to `true` for `MediatorSandbox`).
- If `isolateNetwork` is enabled, the command string is automatically wrapped inside `unshare --user --net --map-root-user --fork --kill-child -- ...`.
- `WslExecutionResult` records `networkIsolated: true`.

---

## 5. Live OS Canary Matrix (Canaries 23–31)

Nine new adversarial canaries were added to `packages/executor-contract/src/wslSandboxCanaries.test.ts`, bringing the live WSL2 canary battery to 31 tests (31/31 PASS):

| Canary ID | Channel Tested | Adversarial Probe | Observed Behavior | Qualification Result |
|---|---|---|---|---|
| **Canary 23** | Direct IPv4 TCP/UDP | TCP connect to `1.1.1.1:80` & UDP sendto `8.8.8.8:53` | Fails with `OSError: [Errno 101] Network is unreachable` | **PASS (VERIFIED)** |
| **Canary 24** | Direct IPv6 TCP/UDP | TCP connect to `[2606:4700:4700::1111]:80` | Fails with `OSError: [Errno 99]` / `[Errno 101]` | **PASS (VERIFIED)** |
| **Canary 25** | Hypervisor DNS Proxy | TCP/UDP connect to `10.255.255.254:53` | Fails with `OSError: [Errno 101]` / `socket.gaierror: [Errno -3]` | **PASS (VERIFIED)** |
| **Canary 26** | DNS Tunneling Vector | Subdomain exfiltration query (`exfil.test.mediator`) | Name resolution fails completely (`[Errno -3]`); zero packet transmission | **PASS (VERIFIED)** |
| **Canary 27** | Host Gateway Reachability | Probe WSL host gateway `172.31.80.1:80` | Fails with `OSError: [Errno 101] Network is unreachable` | **PASS (VERIFIED)** |
| **Canary 28** | Enforcement Tampering | Attempt `nsenter` or creating network interface | Fails with `Operation not permitted` / `Permission denied` | **PASS (VERIFIED)** |
| **Canary 29** | Child Process Confinement | Spawn background child attempting delayed connection | Child inherits netns; fails with Errno 101; terminates on cancellation | **PASS (VERIFIED)** |
| **Canary 30** | Restart Persistence | Terminate `MediatorSandbox` (`wsl -t`) and re-execute | Network namespace isolation persists deterministically on fresh launch | **PASS (VERIFIED)** |
| **Canary 31** | Capability Gate Under S00 | Full capability evaluation with S43 verified network evidence | `network.networkDefaultDeny = VERIFIED`; Autopilot remains `BLOCKED` fail-closed | **PASS (VERIFIED)** |

---

## 6. Authoritative Capability Decision & S00 Invariant

### 6.1 Updated Capabilities
With Canaries 23–31 passing deterministically on live OS:
- `network.networkDefaultDeny`: **`VERIFIED (true)`** (enforced by `host` Linux kernel via user/network namespace isolation).
- All 10 core execution and isolation capabilities are now **VERIFIED** on `MediatorSandbox`.

### 6.2 S00 `NO-GO-AUTOEXEC` Invariant
Passing network isolation canaries does **NOT** grant authority to enable Autopilot.
In accordance with ADR-002, ADR-017, ADR-024, ADR-025, and non-negotiable security rules:
- **Local Autopilot remains strictly `BLOCKED` fail-closed.**
- Mediator operates exclusively in **Review-only V1 mode**.
- Human staging review and explicit approval remain mandatory for all live workspace modifications.
- Any future modification of the S00 gate requires its own independent architectural review sprint.

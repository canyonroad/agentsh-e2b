# E2B Sandbox with agentsh Security

A secure [E2B](https://e2b.dev) sandbox template with [agentsh](https://www.agentsh.org) security enforcement. This template provides a hardened environment for running AI agents with policy-based command and network controls.

## Why agentsh + E2B?

**E2B provides isolation FROM the sandbox. agentsh provides control INSIDE the sandbox.**

| Layer | E2B Alone | E2B + agentsh |
|-------|-----------|---------------|
| **Container Isolation** | ✅ Agent can't escape sandbox | ✅ Same |
| **Command Control** | ❌ Agent can run ANY command | ✅ Policy-based allow/block/approve |
| **Network Control** | ❌ Agent can connect ANYWHERE | ✅ Default-deny allowlist |
| **Cloud Credential Theft** | ❌ Agent can access `169.254.169.254` | ✅ Blocked by policy |
| **Data Exfiltration** | ❌ Agent can POST data anywhere | ✅ Only allowed domains |
| **Destructive Commands** | ❌ `rm -rf /` works | ✅ Blocked + soft-delete recovery |
| **Lateral Movement** | ❌ Agent can scan internal networks | ✅ Private ranges blocked |
| **Audit Trail** | ❌ Limited visibility | ✅ Full command + network logging |
| **Secret Leakage** | ❌ Secrets visible in output | ✅ DLP redacts API keys/tokens |

### The Problem

E2B sandboxes isolate AI agents from your infrastructure—but inside the sandbox, the agent has free rein:

```
┌─────────────────────────────────────────────────────────────┐
│  E2B Sandbox                                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  AI Agent can:                                        │  │
│  │  • Run sudo, ssh, nc, curl to anywhere               │  │
│  │  • Access cloud metadata (169.254.169.254)           │  │
│  │  • Connect to internal networks (10.x, 192.168.x)    │  │
│  │  • Delete critical files (rm -rf)                    │  │
│  │  • Exfiltrate data to attacker-controlled servers    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### The Solution

agentsh adds a policy enforcement layer inside the sandbox:

```
┌─────────────────────────────────────────────────────────────┐
│  E2B Sandbox + agentsh                                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  agentsh Policy Engine                                │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  AI Agent (controlled):                         │  │  │
│  │  │  • Commands: allow list, block sudo/ssh/nc      │  │  │
│  │  │  • Network: allow npm/pypi, block all else      │  │  │
│  │  │  • Files: soft-delete, quarantine recovery      │  │  │
│  │  │  • Output: DLP redacts secrets                  │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key benefit**: The shell shim makes this transparent—agents don't need code changes. Every `/bin/bash` call is automatically policy-enforced.

## agentsh Features in E2B

| Feature | Status | Description |
|---------|--------|-------------|
| **Shell Shim** | ✅ Works | Transparent interception of `/bin/bash` - all shell commands routed through policy engine |
| **Command Policies** | ✅ Works | Block/allow/approve commands based on name, args, paths |
| **Network Policies** | ✅ Works | Default-deny allowlist for outbound connections |
| **Cloud Metadata Protection** | ✅ Works | Blocks `169.254.169.254` and cloud provider endpoints |
| **Private Network Isolation** | ✅ Works | Blocks `10.x`, `172.16.x`, `192.168.x` ranges |
| **E2B Infrastructure Protection** | ✅ Works | Blocks access to E2B internal services (`192.0.2.x`, `169.254.x`) |
| **DLP / Secret Redaction** | ✅ Works | Redacts API keys, tokens, secrets from command output |
| **Session Management** | ✅ Works | Isolated sessions with workspace binding |
| **Soft-Delete / Quarantine** | ✅ Works | Deleted files moved to quarantine for recovery |
| **Audit Logging** | ✅ Works | All commands logged with decisions and timing |
| **Package Registry Access** | ✅ Works | Allowlist for npm, PyPI, crates.io, Go modules |
| **HTTP Proxy** | ✅ Works | Network traffic routed through policy-enforcing proxy |
| **Seccomp** | ✅ Works | Per-command seccomp wrapper with `no_new_privileges` — blocks sudo even via indirect paths |
| **eBPF** | ✅ Works | eBPF-based monitoring and enforcement |
| **FUSE** | ✅ Works | Deferred FUSE filesystem for file operation interception |
| **Cgroups v2** | ✅ Works | Resource limits via cgroups v2 |
| **Landlock** | ✅ Works | Landlock ABI v2 for additional filesystem restrictions |
| **Env Policy** | ✅ Works | Environment variable filtering with allow/deny lists |
| **Resource Limits** | ✅ Works | PID limits, memory limits, CPU quota, disk I/O limits |

### Features Not Available in E2B

| Feature | Status | Reason |
|---------|--------|--------|
| **Interactive Approvals** | ⚠️ Limited | E2B sandboxes typically run unattended; no human to approve |
| **Landlock Network** | ❌ N/A | Requires kernel 6.7+ (Landlock ABI v4); use proxy-based network control instead |
| **PID Namespace** | ❌ N/A | E2B manages process isolation at the sandbox level |
| **PTY/Terminal Sessions** | ⚠️ Limited | E2B uses non-interactive command execution |

## Quick Start

### Prerequisites

- Node.js 18+
- E2B account and API key
- Set environment variables in `.env`:
  ```
  E2B_ACCESS_TOKEN=your_access_token
  E2B_API_KEY=your_api_key
  ```

### Build the Template

```bash
npm install
npx tsx build.prod.ts
```

### Use the Template

```typescript
import { Sandbox } from 'e2b'  // Use generic Sandbox, NOT @e2b/code-interpreter

const sbx = await Sandbox.create('e2b-agentsh')

// Server starts automatically via startup script (includes shell shim installation)
// Verify server is running
const health = await sbx.commands.run('curl -s http://127.0.0.1:18080/health')
console.log('Server status:', health.stdout)  // "ok"

// Create a session
const sess = await sbx.commands.run('agentsh session create --workspace /home/user --json')
const sessionData = JSON.parse(sess.stdout.trim())
const sessionId = sessionData.id

// Run commands through agentsh (policy enforced)
const result = await sbx.commands.run(`agentsh exec ${sessionId} -- /bin/echo Hello, secure world!`)
console.log(result.stdout)

// Or just use bash directly - the shell shim intercepts it automatically
const shimResult = await sbx.commands.run('/bin/bash -c "echo Hello through shim"')
console.log(shimResult.stdout)

await sbx.kill()
```

> **Important**: Use `import { Sandbox } from 'e2b'` not `@e2b/code-interpreter`. The code-interpreter package overrides custom templates.

## Security Policy

The default policy (`default.yaml`) implements a **default-deny allowlist** approach:

### Command Blocking

| Category | Blocked Commands | Policy Rule |
|----------|------------------|-------------|
| Privilege Escalation | `sudo`, `su`, `chroot`, `nsenter` | `block-shell-escape` |
| Network Tools | `ssh`, `nc`, `netcat`, `telnet`, `scp` | `block-network-tools` |
| System Commands | `kill`, `shutdown`, `systemctl`, `mount` | `block-system-commands` |
| Recursive Delete | `rm -rf`, `rm -r`, `rm --recursive` | `block-rm-recursive` |
| E2B Infrastructure | `socat`, `envd`, `iptables`, `ip` | `block-e2b-interference` |

**Allowed**: Standard commands (`ls`, `cat`, `grep`), dev tools (`git`, `python3`, `node`, `npm`), single-file operations.

### Network Blocking

| Category | Destinations | Result |
|----------|--------------|--------|
| **Allowed** | `127.0.0.1:18080` (localhost/agentsh) | HTTP 200 |
| | `registry.npmjs.org` | HTTP 200 |
| | `pypi.org`, `files.pythonhosted.org` | HTTP 200 |
| | `crates.io`, `static.crates.io` | HTTP 200 |
| | `proxy.golang.org`, `sum.golang.org` | HTTP 200 |
| **Blocked** | `169.254.169.254` (cloud metadata) | HTTP 403 |
| | `192.0.2.0/24` (E2B internal services) | HTTP 403 |
| | `10.0.0.0/8` (private network) | HTTP 403 |
| | `172.16.0.0/12` (private network) | HTTP 403 |
| | `192.168.0.0/16` (private network) | HTTP 403 |
| | All other domains | HTTP 403 (default-deny) |

## Demo Results

### Command Blocking Demo

```
=== ALLOWED COMMANDS ===
--- /bin/echo Hello ---           ✓ ALLOWED (exit: 0)
--- /bin/pwd ---                  ✓ ALLOWED (exit: 0)
--- /usr/bin/python3 -c print(1) --- ✓ ALLOWED (exit: 0)
--- /usr/bin/git --version ---    ✓ ALLOWED (exit: 0)

=== BLOCKED: Privilege Escalation ===
--- /usr/bin/sudo whoami ---      ✗ BLOCKED (rule: block-shell-escape)
--- /bin/su - ---                 ✗ BLOCKED (rule: block-shell-escape)

=== BLOCKED: Network Tools ===
--- /usr/bin/ssh localhost ---    ✗ BLOCKED (rule: block-network-tools)
--- /bin/nc -h ---                ✗ BLOCKED (rule: block-network-tools)

=== BLOCKED: System Commands ===
--- /bin/kill -9 1 ---            ✗ BLOCKED (rule: block-system-commands)
--- /sbin/shutdown now ---        ✗ BLOCKED (rule: block-system-commands)

=== BLOCKED: Recursive Delete ===
--- /bin/rm -rf /tmp/test ---     ✗ BLOCKED (rule: block-rm-recursive)

=== FILESYSTEM: Workspace Access (allowed) ===
--- Write to workspace ---        ✓ ALLOWED (exit: 0)
--- Read from workspace ---       ✓ ALLOWED (exit: 0)

=== FILESYSTEM: Blocked paths ===
--- Read /proc/1/environ ---      ✗ BLOCKED (rule: deny-proc-sys)
--- Read /sys/kernel/hostname --- ✗ BLOCKED (rule: deny-proc-sys)
--- Write to /etc/passwd ---      ✗ BLOCKED (rule: default-deny-files)
--- Write outside workspace ---   ✗ BLOCKED (rule: default-deny-files)

=== FILESYSTEM: Credential access (blocked/approve) ===
--- Read ~/.ssh/id_rsa ---        ✗ BLOCKED (rule: approve-ssh-access)
--- Read ~/.aws/credentials ---   ✗ BLOCKED (rule: approve-aws-credentials)
--- Read .env file ---            ✗ BLOCKED (rule: approve-env-files)

=== FILESYSTEM: Soft-delete in workspace ===
--- Delete workspace file ---     ✓ SOFT-DELETE (quarantined, recoverable)
```

### Network Blocking Demo

```
=== LOCALHOST - ALLOWED ===
curl http://127.0.0.1:18080/health → ok HTTP_CODE:200

=== CLOUD METADATA - BLOCKED ===
curl http://169.254.169.254/ → blocked by policy HTTP_CODE:403
  (rule=block-private-networks)

=== PRIVATE NETWORKS - BLOCKED ===
curl http://10.0.0.1/ → blocked by policy HTTP_CODE:403
curl http://192.168.1.1/ → blocked by policy HTTP_CODE:403

=== PACKAGE REGISTRIES - ALLOWED ===
curl https://registry.npmjs.org/ → HTTP_CODE:200
curl https://pypi.org/ → HTTP_CODE:200

=== UNKNOWN DOMAINS - BLOCKED (default-deny) ===
curl https://example.com/ → blocked by policy (rule=default-deny-network)
curl https://httpbin.org/get → blocked by policy (rule=default-deny-network)
```

## Customizing the Policy

### Adding Allowed Domains

Edit `default.yaml` to add domains to the allowlist:

```yaml
network_rules:
  # ... existing rules ...

  - name: allow-github
    description: GitHub API access
    domains:
      - "api.github.com"
      - "github.com"
      - "raw.githubusercontent.com"
    ports: [443]
    decision: allow

  - name: allow-custom-api
    description: Your internal API
    domains:
      - "api.yourcompany.com"
    ports: [443]
    decision: allow
```

### Adding Allowed Commands

```yaml
command_rules:
  # ... existing rules ...

  - name: allow-docker
    description: Allow docker commands
    commands:
      - docker
    decision: allow
```

### Requiring Approval Instead of Blocking

For sensitive operations, use `decision: approve` to require human approval:

```yaml
  - name: approve-npm-install
    description: Require approval for package installation
    commands:
      - npm
    args_patterns:
      - "^install.*"  # regex pattern (v0.7.10+)
    decision: approve
    message: "Agent wants to install packages: {{.Args}}"
    timeout: 5m
```

> Note: Approvals require `approvals.enabled: true` in `config.yaml`

### Environment Variable Filtering

The `env_policy` section in `default.yaml` controls which environment variables commands can access:

```yaml
env_policy:
  # Allowlist - only these vars are visible to commands
  allow:
    - PATH
    - HOME
    - USER
    - NODE_ENV
    - PYTHONPATH
    - GIT_*           # Wildcards supported
    - AGENTSH_*

  # Denylist - these are always blocked (takes precedence over allow)
  deny:
    - AWS_*
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
    - DATABASE_URL
    - SECRET_*
    - PASSWORD*
    - TOKEN*

  # Limits to prevent env enumeration attacks
  max_bytes: 65536      # Max total size of env vars
  max_keys: 100         # Max number of env vars
  block_iteration: true # Prevent enumeration of all env vars
```

This prevents credential leakage by ensuring agents can only see necessary environment variables while blocking access to secrets like API keys and database credentials.

## E2B Capability Detection

Running `agentsh detect` inside the E2B sandbox shows the available security features:

```
Platform: linux
Security Mode: landlock-only
Protection Score: 80%

CAPABILITIES
----------------------------------------
  capabilities_drop        ✓
  cgroups_v2               ✓
  ebpf                     ✓
  fuse                     -
  landlock                 ✓
  landlock_abi             ✓ (v2)
  landlock_network         -
  pid_namespace            -
  seccomp                  ✓
  seccomp_basic            ✓
  seccomp_user_notify      ✓
```

FUSE is available at runtime via deferred mounting (activated on first exec after `chmod 666 /dev/fuse`). The `agentsh detect` output reflects the state at detection time before FUSE is enabled.

## Files

| File | Description |
|------|-------------|
| `template.ts` | E2B template definition (v2 SDK) |
| `build.prod.ts` | Build script |
| `config.yaml` | agentsh server configuration |
| `default.yaml` | Security policy (command/network/file rules) |
| `agentsh-startup.sh` | Sandbox startup script (server + shim) |
| `enable-fuse.sh` | Runtime FUSE enablement helper |
| `demo-blocking.ts` | Command and filesystem blocking |
| `demo-network.ts` | Network policy blocking |
| `demo-quarantine.ts` | Soft-delete and quarantine recovery |
| `demo-env-filtering.ts` | Environment variable filtering |
| `demo-package-approval.ts` | Package install approval rules |
| `demo-detect.ts` | Security capability detection |
| `demo-audit.ts` | Audit trail and event logging |
| `demo-attack-sim.ts` | Red team attack simulation (44 attacks) |
| `demo-resource-limits.ts` | Resource limits (PID, memory, CPU, I/O) |
| `demo-multi-context.ts` | Multi-context command blocking (env, xargs, scripts, Python) |
| `demo-fuse-protection.ts` | FUSE/VFS-level file protection (symlinks, Python I/O) |
| `test-template.ts` | Template verification tests |

## How It Works

1. **Template Build** - Installs agentsh v0.10.1 on top of `e2bdev/code-interpreter:latest`
2. **Sandbox Start** - Startup script runs automatically:
   - Starts `agentsh server` on port 18080
   - Installs shell shim (replaces `/bin/bash` with agentsh shim, moves real bash to `/bin/bash.real`)
3. **Command Execution** - Two modes:
   - **Shell Shim (transparent)**: Any `/bin/bash` call is intercepted and policy-enforced automatically
   - **HTTP API**: Use the exec API at `http://127.0.0.1:18080/api/v1/sessions/{id}/exec` for direct policy enforcement
4. **Network Proxy** - All network traffic routes through agentsh's proxy for policy enforcement
5. **Seccomp Wrapper** - Each command is wrapped with seccomp (`no_new_privileges` flag), preventing privilege escalation via sudo even through indirect execution (env, xargs, scripts, Python subprocess)
6. **Deferred FUSE** - FUSE filesystem mounts on first exec (not at startup) for E2B snapshot compatibility

## Requirements

- agentsh v0.10.1+
- E2B v2 Template SDK
- Generic `e2b` package (not `@e2b/code-interpreter`)

## License

MIT

## Related

- [agentsh](https://www.agentsh.org) - Security sandbox for AI agents
- [E2B](https://e2b.dev) - Cloud sandbox platform

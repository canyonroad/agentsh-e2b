# agentsh + E2B

Runtime security governance for AI agents using [agentsh](https://github.com/canyonroad/agentsh) v0.10.4 with [E2B](https://e2b.dev) sandboxes.

## Why agentsh + E2B?

**E2B provides isolation. agentsh provides governance.**

E2B sandboxes give AI agents a secure, isolated compute environment. But isolation alone doesn't prevent an agent from:

- **Exfiltrating data** to unauthorized endpoints
- **Accessing cloud metadata** (AWS/GCP/Azure credentials at 169.254.169.254)
- **Leaking secrets** in outputs (API keys, tokens, PII)
- **Running dangerous commands** (sudo, ssh, kill, nc)
- **Reaching internal networks** (10.x, 172.16.x, 192.168.x)
- **Deleting workspace files** permanently

agentsh adds the governance layer that controls what agents can do inside the sandbox, providing defense-in-depth:

```
+---------------------------------------------------------+
|  E2B Sandbox (Isolation)                                |
|  +---------------------------------------------------+  |
|  |  agentsh (Governance)                             |  |
|  |  +---------------------------------------------+  |  |
|  |  |  AI Agent                                   |  |  |
|  |  |  - Commands are policy-checked              |  |  |
|  |  |  - Network requests are filtered            |  |  |
|  |  |  - File I/O is intercepted (FUSE)           |  |  |
|  |  |  - Secrets are redacted from output         |  |  |
|  |  |  - All actions are audited                  |  |  |
|  |  +---------------------------------------------+  |  |
|  +---------------------------------------------------+  |
+---------------------------------------------------------+
```

## What agentsh Adds

| E2B Provides | agentsh Adds |
|--------------|--------------|
| Compute isolation | Command blocking (seccomp) |
| Process sandboxing | File I/O policy (FUSE) |
| API access to sandbox | Domain allowlist/blocklist |
| Persistent environment | Cloud metadata blocking |
| | Environment variable filtering |
| | Secret detection and redaction (DLP) |
| | Bash builtin interception (BASH_ENV) |
| | Landlock execution restrictions |
| | Soft-delete file quarantine |
| | LLM request auditing |
| | Complete audit logging |

## Quick Start

### Prerequisites

- Node.js 18+
- [E2B](https://e2b.dev) account and API key
- Set environment variables in `.env`:
  ```
  E2B_ACCESS_TOKEN=your_access_token
  E2B_API_KEY=your_api_key
  ```

### Build and Test

```bash
git clone https://github.com/canyonroad/e2b-agentsh
cd e2b-agentsh
npm install

# Build the E2B template
npx tsx build.prod.ts

# Run the full test suite (76 tests)
npx tsx test-template.ts
```

> **Important**: Use `import { Sandbox } from 'e2b'` not `@e2b/code-interpreter`. The code-interpreter package overrides custom templates.

## How It Works

agentsh replaces `/bin/bash` with a [shell shim](https://www.agentsh.org/docs/#shell-shim) that routes every command through the policy engine:

```
sbx.commands.run: /bin/bash -c "sudo whoami"
                     |
                     v
            +-------------------+
            |  Shell Shim       |  /bin/bash -> agentsh-shell-shim
            |  (intercepts)     |
            +--------+----------+
                     |
                     v
            +-------------------+
            |  agentsh server   |  Policy evaluation + seccomp
            |  (auto-started)   |  + FUSE file interception
            +--------+----------+
                     |
              +------+------+
              v             v
        +----------+  +----------+
        |  ALLOW   |  |  BLOCK   |
        | exit: 0  |  | exit: 126|
        +----------+  +----------+
```

Every command that E2B's `sbx.commands.run()` executes is automatically intercepted -- no explicit `agentsh exec` calls needed. The startup script installs the shell shim and starts the agentsh server on port 18080.

## Configuration

Security policy is defined in two files:

- **`config.yaml`** -- Server configuration: network interception, [DLP patterns](https://www.agentsh.org/docs/#llm-proxy), LLM proxy, [FUSE settings](https://www.agentsh.org/docs/#fuse), [seccomp](https://www.agentsh.org/docs/#seccomp), [env_inject](https://www.agentsh.org/docs/#shell-shim) (BASH_ENV for builtin blocking)
- **`default.yaml`** -- [Policy rules](https://www.agentsh.org/docs/#policy-reference): [command rules](https://www.agentsh.org/docs/#command-rules), [network rules](https://www.agentsh.org/docs/#network-rules), [file rules](https://www.agentsh.org/docs/#file-rules), [environment policy](https://www.agentsh.org/docs/#environment-policy)

See the [agentsh documentation](https://www.agentsh.org/docs/) for the full policy reference.

## Project Structure

```
e2b-agentsh/
├── template.ts              # E2B template definition (v2 SDK)
├── build.prod.ts            # Build script
├── config.yaml              # Server config (FUSE, seccomp, DLP, network)
├── default.yaml             # Security policy (commands, network, files, env)
├── agentsh-startup.sh       # Sandbox startup script (server + shim)
├── enable-fuse.sh           # Runtime FUSE enablement helper
├── test-template.ts         # Template verification tests (76 tests)
├── demo-blocking.ts         # Command and filesystem blocking
├── demo-network.ts          # Network policy blocking
├── demo-quarantine.ts       # Soft-delete and quarantine recovery
├── demo-env-filtering.ts    # Environment variable filtering
├── demo-package-approval.ts # Package install approval rules
├── demo-detect.ts           # Security capability detection
├── demo-audit.ts            # Audit trail and event logging
├── demo-attack-sim.ts       # Red team attack simulation (44 attacks)
├── demo-resource-limits.ts  # Resource limits (PID, memory, CPU, I/O)
├── demo-multi-context.ts    # Multi-context command blocking
├── demo-fuse-protection.ts  # FUSE/VFS-level file protection
└── package.json
```

## Testing

The `test-template.ts` script creates an E2B sandbox and runs 76 security tests across 12 categories:

- **Installation** -- agentsh binary, seccomp linkage
- **Server & config** -- health check, policy/config files, FUSE deferred, seccomp enabled
- **Shell shim** -- static linked shim, bash.real preserved, echo/Python through shim
- **Policy evaluation** -- static policy-test for sudo, echo, workspace, credentials, /etc
- **Security diagnostics** -- agentsh detect: seccomp, cgroups_v2, landlock, ebpf
- **Command blocking** -- sudo, su, ssh, kill, rm -rf blocked; echo, python3, git allowed
- **Network blocking** -- npmjs.org allowed; metadata, evil.com, private networks, github.com blocked
- **Environment policy** -- sensitive vars filtered, HOME/PATH present, BASH_ENV set
- **File I/O** -- workspace/tmp writes allowed; /etc, /usr/bin writes blocked (FUSE); symlink escape blocked
- **Multi-context blocking** -- env/xargs/find -exec/Python subprocess/os.system sudo blocked
- **FUSE workspace** -- session workspace-mnt exists, soft-delete create/rm/verify
- **Credential blocking** -- ~/.ssh/id_rsa, ~/.aws/credentials, /proc/1/environ blocked

```bash
npx tsx test-template.ts
```

## Related Projects

- [agentsh](https://github.com/canyonroad/agentsh) -- Runtime security for AI agents ([docs](https://www.agentsh.org/docs/))
- [agentsh + Blaxel](https://github.com/canyonroad/agentsh-blaxel) -- agentsh integration with Blaxel sandboxes
- [agentsh + Daytona](https://github.com/canyonroad/agentsh-daytona) -- agentsh integration with Daytona sandboxes
- [E2B](https://e2b.dev) -- Cloud sandbox platform

## License

MIT

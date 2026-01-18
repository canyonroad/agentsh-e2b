# E2B Sandbox with agentsh Security

A secure [E2B](https://e2b.dev) sandbox template with [agentsh](https://www.agentsh.org) security enforcement. This template provides a hardened environment for running AI agents with policy-based command and network controls.

## Features

- **Command Policy Enforcement** - Block dangerous commands like `sudo`, `ssh`, `rm -rf`
- **Network Policy Enforcement** - Default-deny allowlist for network access
- **Cloud Metadata Protection** - Blocks access to AWS/GCP/Azure instance credentials
- **Private Network Isolation** - Prevents lateral movement to internal hosts
- **Package Registry Access** - Allows npm, PyPI, crates.io, Go modules
- **DLP (Data Loss Prevention)** - Redacts API keys, tokens, and secrets from output

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

// Start agentsh server
await sbx.commands.run('/usr/local/bin/agentsh-startup.sh')

// Create a session
const sess = await sbx.commands.run('agentsh session create --workspace /home/user --json')
const sessionId = JSON.parse(sess.stdout.trim()).session_id

// Run commands through agentsh (policy enforced)
const cmd = JSON.stringify({ command: '/bin/echo', args: ['Hello, secure world!'] })
const result = await sbx.commands.run(`agentsh exec ${sessionId} --json '${cmd}'`)
console.log(result.stdout)

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
| **Allowed** | `127.0.0.1` (localhost) | HTTP 200 |
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
```

### Network Blocking Demo

```
=== LOCALHOST - ALLOWED ===
curl http://127.0.0.1:8080/health → ok HTTP_CODE:200

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

## Files

| File | Description |
|------|-------------|
| `template.ts` | E2B template definition (v2 SDK) |
| `build.prod.ts` | Build script |
| `config.yaml` | agentsh server configuration |
| `default.yaml` | Security policy (command/network rules) |
| `demo-blocking.ts` | Command blocking demonstration |
| `demo-network.ts` | Network blocking demonstration |
| `test-template.ts` | Template verification tests |

## How It Works

1. **Template Build** - Installs agentsh v0.7.10+ on top of `e2bdev/code-interpreter:latest`
2. **Sandbox Start** - `agentsh server` starts automatically via startup script
3. **Session Creation** - Create a session with `agentsh session create`
4. **Command Execution** - Run commands via `agentsh exec` which enforces policies
5. **Network Proxy** - All network traffic routes through agentsh's proxy for policy enforcement

## Requirements

- agentsh v0.7.10+ (regex patterns for args_patterns)
- E2B v2 Template SDK
- Generic `e2b` package (not `@e2b/code-interpreter`)

## License

MIT

## Related

- [agentsh](https://www.agentsh.org) - Security sandbox for AI agents
- [E2B](https://e2b.dev) - Cloud sandbox platform

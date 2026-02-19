import 'dotenv/config'
import { Sandbox } from 'e2b'

const AGENTSH_API = 'http://127.0.0.1:18080'

async function main() {
  console.log('Creating sandbox...')
  const sbx = await Sandbox.create('e2b-agentsh')

  try {
    console.log(`Sandbox created: ${sbx.sandboxId}\n`)

    // Wait for agentsh server to be fully ready
    for (let i = 0; i < 10; i++) {
      try {
        const h = await sbx.commands.run(`curl -sf http://127.0.0.1:18080/health`, { timeout: 3 })
        if (h.stdout.trim() === 'ok') break
      } catch {}
      await new Promise(r => setTimeout(r, 1000))
    }

    // Create a session via HTTP API
    // Write JSON body to file to avoid shell quoting issues with the shim
    console.log('=== Creating agentsh session ===')
    await sbx.files.write('/tmp/session-req.json', '{"workspace":"/home/user"}')
    const createSession = await sbx.commands.run(
      `curl -s -X POST ${AGENTSH_API}/api/v1/sessions -H "Content-Type: application/json" -d @/tmp/session-req.json`
    )
    const sessionData = JSON.parse(createSession.stdout)
    const sessionId = sessionData.id
    console.log(`Session ID: ${sessionId}\n`)

    console.log('='.repeat(60))
    console.log('DEMONSTRATING AGENTSH POLICY BLOCKING')
    console.log('='.repeat(60))

    // Helper to run via agentsh exec HTTP API
    let reqCounter = 0
    async function runAgentsh(description: string, command: string, args: string[] = []) {
      console.log(`\n--- ${description} ---`)
      const body = JSON.stringify({ command, args })
      // Write JSON body to unique temp file to avoid races with the shim
      const reqFile = `/tmp/exec-req-${++reqCounter}.json`
      await sbx.files.write(reqFile, body)
      const cmd = `curl -s -X POST "${AGENTSH_API}/api/v1/sessions/${sessionId}/exec" -H "Content-Type: application/json" -d @${reqFile} --max-time 10`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 15 })
        const resp = JSON.parse(result.stdout)
        const exitCode = resp.result?.exit_code
        const stderr = resp.result?.stderr || ''
        const errorMsg = resp.result?.error?.message || ''

        // Extract rule name from guidance or blocked_operations
        const guidanceRule = resp.guidance?.policy_rule
        const blocked = resp.events?.blocked_operations || []
        const blockedRule = blocked[0]?.policy?.rule

        if (guidanceRule || blockedRule) {
          const rule = guidanceRule || blockedRule
          console.log(`✗ BLOCKED (rule: ${rule})`)
          return false
        } else if (exitCode === 0) {
          console.log(`✓ ALLOWED (exit: ${exitCode})`)
          return true
        } else if (stderr.includes('Permission denied') || stderr.includes('denied') || errorMsg.includes('denied')) {
          console.log(`✗ BLOCKED by security layer (exit: ${exitCode})`)
          return false
        } else {
          console.log(`✗ DENIED (exit: ${exitCode})`)
          return false
        }
      } catch (e: any) {
        const output = e.result?.stdout || ''
        console.log(`✗ ERROR: ${output.slice(0, 200)}`)
        return false
      }
    }

    console.log('\n=== 1. ALLOWED COMMANDS ===')
    console.log('(Commands that pass policy)')

    await runAgentsh('/usr/bin/echo Hello', '/bin/bash.real', ['-c', 'echo Hello'])
    await runAgentsh('/usr/bin/pwd', '/usr/bin/pwd')
    await runAgentsh('/usr/bin/id', '/usr/bin/id')
    await runAgentsh('/usr/bin/ls /home', '/usr/bin/ls', ['/home'])
    await runAgentsh('/usr/bin/date', '/usr/bin/date')
    await runAgentsh('/usr/bin/python3 -c print(1)', '/usr/bin/python3', ['-c', 'print(1)'])
    await runAgentsh('/usr/bin/git --version', '/usr/bin/git', ['--version'])
    await runAgentsh('/usr/bin/agentsh --version', '/usr/bin/agentsh', ['--version'])

    console.log('\n=== 2. DIAGNOSTICS ===')
    console.log('(Verify security subsystems are active)')

    await runAgentsh('HTTPS_PROXY is set', '/bin/bash.real', ['-c', 'echo $HTTPS_PROXY'])
    await runAgentsh('FUSE mounted', '/bin/bash.real', ['-c', 'mount | grep agentsh || echo "FUSE NOT MOUNTED (deferred until first exec)"'])
    await runAgentsh('BASH_ENV active', '/bin/bash.real', ['-c', 'echo $BASH_ENV'])
    await runAgentsh('kill builtin disabled', '/bin/bash.real', ['-c', 'type kill 2>&1'])
    await runAgentsh('Read system binary (stat)', '/usr/bin/ls', ['-la', '/usr/bin/ls'])

    console.log('\n=== 3. BLOCKED: Privilege Escalation ===')

    await runAgentsh('/usr/bin/sudo whoami', '/usr/bin/sudo', ['whoami'])
    await runAgentsh('/usr/bin/su -', '/usr/bin/su', ['-'])
    await runAgentsh('/usr/sbin/chroot /', '/usr/sbin/chroot', ['/'])

    console.log('\n=== 4. BLOCKED: Network Tools ===')

    await runAgentsh('/usr/bin/ssh localhost', '/usr/bin/ssh', ['localhost'])
    await runAgentsh('/usr/bin/nc -h', '/usr/bin/nc', ['-h'])
    await runAgentsh('/usr/bin/netcat -h', '/usr/bin/netcat', ['-h'])

    console.log('\n=== 5. BLOCKED: System Commands ===')

    await runAgentsh('/usr/bin/kill -9 1', '/usr/bin/kill', ['-9', '1'])
    await runAgentsh('/usr/sbin/shutdown now', '/usr/sbin/shutdown', ['now'])
    await runAgentsh('/usr/bin/systemctl status', '/usr/bin/systemctl', ['status'])

    console.log('\n=== 6. BLOCKED: Recursive Delete ===')

    // Create test files first via API
    await runAgentsh('setup: mkdir + touch', '/bin/bash.real', ['-c', 'mkdir -p /tmp/test && touch /tmp/test/file.txt'])
    await runAgentsh('/usr/bin/rm -rf /tmp/test', '/usr/bin/rm', ['-rf', '/tmp/test'])
    await runAgentsh('/usr/bin/rm -r /tmp/test', '/usr/bin/rm', ['-r', '/tmp/test'])
    await runAgentsh('/usr/bin/rm --recursive /tmp/test', '/usr/bin/rm', ['--recursive', '/tmp/test'])

    // But single file delete is allowed
    console.log('\n=== 7. ALLOWED: Single File Delete ===')
    await runAgentsh('setup: mkdir + touch', '/bin/bash.real', ['-c', 'mkdir -p /tmp/test && touch /tmp/test/file.txt'])
    await runAgentsh('/usr/bin/rm /tmp/test/file.txt (single)', '/usr/bin/rm', ['/tmp/test/file.txt'])

    console.log('\n=== 8. FILESYSTEM: Workspace Access (allowed) ===')

    await runAgentsh('Write to workspace', '/usr/bin/python3', ['-c', 'open("/home/user/test-fs.txt","w").write("hello\\n")'])
    await runAgentsh('Read from workspace', '/usr/bin/cat', ['/home/user/test-fs.txt'])
    await runAgentsh('List workspace', '/usr/bin/ls', ['/home/user/test-fs.txt'])

    console.log('\n=== 9. FILESYSTEM: Blocked paths ===')

    await runAgentsh('Read /proc/1/environ', '/usr/bin/cat', ['/proc/1/environ'])
    await runAgentsh('Read /sys/kernel/hostname', '/usr/bin/cat', ['/sys/kernel/hostname'])
    await runAgentsh('Write to /etc/passwd', '/usr/bin/python3', ['-c', 'open("/etc/passwd","a").write("pwned\\n")'])
    await runAgentsh('Write outside workspace', '/usr/bin/python3', ['-c', 'open("/var/escape.txt","w").write("escape\\n")'])

    console.log('\n=== 10. FILESYSTEM: Credential access (blocked/approve) ===')

    await runAgentsh('Read ~/.ssh/id_rsa', '/usr/bin/cat', ['/home/user/.ssh/id_rsa'])
    await runAgentsh('Read ~/.aws/credentials', '/usr/bin/cat', ['/home/user/.aws/credentials'])
    await runAgentsh('Read .env file', '/usr/bin/cat', ['/home/user/.env'])

    console.log('\n=== 11. FILESYSTEM: Soft-delete in workspace ===')

    await runAgentsh('Create file', '/usr/bin/python3', ['-c', 'open("/home/user/soft-del.txt","w").write("important\\n")'])
    await runAgentsh('Delete workspace file (soft-delete)', '/usr/bin/rm', ['/home/user/soft-del.txt'])
    await runAgentsh('Verify original path gone', '/usr/bin/ls', ['/home/user/soft-del.txt'])

    console.log('\n' + '='.repeat(60))
    console.log('SUMMARY')
    console.log('='.repeat(60))
    console.log(`
agentsh policy enforcement in action:

DIAGNOSTICS:
  ✓ HTTPS_PROXY           → Proxy routing active
  ✓ FUSE mounted          → VFS interception (deferred until first exec)
  ✓ BASH_ENV active       → Shell builtin disabling
  ✓ kill builtin disabled → kill is /usr/bin/kill, not a shell builtin
  ✓ Read system binary    → stat /usr/bin/ls allowed (read-only)
  ✓ agentsh --version     → Binary accessible

COMMAND BLOCKING:
  ✗ sudo, su, chroot    → rule: block-shell-escape
  ✗ ssh, nc, netcat     → rule: block-network-tools
  ✗ kill, shutdown      → rule: block-system-commands
  ✗ rm -r, rm -rf       → rule: block-rm-recursive

FILESYSTEM BLOCKING:
  ✗ /proc/**            → rule: deny-proc-sys
  ✗ /sys/**             → rule: deny-proc-sys
  ✗ /etc/passwd (write) → rule: default-deny-files
  ✗ /var (write)        → rule: default-deny-files
  ✗ ~/.ssh/**           → rule: approve-ssh-access (blocked unattended)
  ✗ ~/.aws/**           → rule: approve-aws-credentials (blocked unattended)
  ✗ **/.env             → rule: approve-env-files (blocked unattended)

FILESYSTEM ALLOWED:
  ✓ Workspace read/write → rules: allow-workspace-read/write
  ✓ Workspace delete     → rule: soft-delete-workspace (quarantined)
  ✓ /tmp/**              → rule: allow-tmp

COMMANDS ALLOWED:
  ✓ echo, pwd, ls, date → Standard commands
  ✓ python3, git        → Development tools
  ✓ rm (single file)    → Non-recursive delete
`)

  } catch (error) {
    console.error('Error:', error)
  } finally {
    console.log('\nCleaning up...')
    await sbx.kill()
    console.log('Done.')
  }
}

main().catch(console.error)

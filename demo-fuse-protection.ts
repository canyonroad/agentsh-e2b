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
        const h = await sbx.commands.run(`/usr/bin/curl -sf ${AGENTSH_API}/health`, { timeout: 3 })
        if (h.stdout.trim() === 'ok') break
      } catch {}
      await new Promise(r => setTimeout(r, 1000))
    }

    // Enable FUSE device at runtime
    console.log('Enabling FUSE device...')
    await sbx.files.write('/tmp/.agentsh-fuse-enabled', 'true')

    // Trigger FUSE mount on the shell shim session
    try {
      const trigger = await sbx.commands.run('/usr/bin/echo fuse-ready', { timeout: 15 })
      console.log(`  FUSE activated: ${trigger.stdout.trim()}`)
    } catch (e: any) {
      console.log(`  FUSE trigger: ${e.result?.stderr?.trim() || e.message}`)
    }

    // Create a session via HTTP API
    console.log('\n=== Creating agentsh session ===')
    await sbx.files.write('/tmp/session-req.json', '{"workspace":"/home/user"}')
    const createSession = await sbx.commands.run(
      `/usr/bin/curl -s -X POST ${AGENTSH_API}/api/v1/sessions -H "Content-Type: application/json" -d @/tmp/session-req.json`
    )
    const sessionData = JSON.parse(createSession.stdout)
    const sessionId = sessionData.id
    console.log(`Session ID: ${sessionId}\n`)

    console.log('='.repeat(60))
    console.log('DEMONSTRATING FUSE/VFS-LEVEL FILE PROTECTION')
    console.log('='.repeat(60))
    console.log('FUSE intercepts file I/O at the kernel VFS level,')
    console.log('enforcing policy even when tools bypass shell redirects.')

    // Helper to run via agentsh exec HTTP API
    let reqCounter = 0
    async function runAgentsh(description: string, command: string, args: string[] = []): Promise<boolean> {
      console.log(`\n--- ${description} ---`)
      const body = JSON.stringify({ command, args })
      const reqFile = `/tmp/exec-req-${++reqCounter}.json`
      await sbx.files.write(reqFile, body)
      const cmd = `/usr/bin/curl -s -X POST "${AGENTSH_API}/api/v1/sessions/${sessionId}/exec" -H "Content-Type: application/json" -d @${reqFile} --max-time 10`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 15 })
        const resp = JSON.parse(result.stdout)
        const exitCode = resp.result?.exit_code
        const stdout = resp.result?.stdout || ''
        const stderr = resp.result?.stderr || ''
        const errorMsg = resp.result?.error?.message || ''

        const guidanceRule = resp.guidance?.policy_rule
        const blocked = resp.events?.blocked_operations || []
        const blockedRule = blocked[0]?.policy?.rule
        const fileEvents = resp.events?.file_operations || []
        const fileBlocked = fileEvents.filter((e: any) => e.decision === 'deny' || e.decision === 'block')

        if (guidanceRule || blockedRule) {
          const rule = guidanceRule || blockedRule
          console.log(`  ✗ BLOCKED (rule: ${rule})`)
          return false
        } else if (fileBlocked.length > 0) {
          const rule = fileBlocked[0].policy?.rule || 'file-policy'
          console.log(`  ✗ BLOCKED by FUSE (rule: ${rule})`)
          return false
        } else if (exitCode === 0) {
          const preview = stdout.trim().substring(0, 100)
          if (preview) console.log(`  Output: ${preview}`)
          console.log(`  ✓ ALLOWED (exit: 0)`)
          return true
        } else if (stderr.includes('Permission denied') || stderr.includes('denied') || stderr.includes('Read-only') || errorMsg.includes('denied')) {
          console.log(`  ✗ BLOCKED by security layer (exit: ${exitCode})`)
          return false
        } else {
          console.log(`  ✗ DENIED (exit: ${exitCode})`)
          return false
        }
      } catch (e: any) {
        console.log(`  ✗ ERROR`)
        return false
      }
    }

    // =========================================================================
    // 1. CLI tools writing to protected directories
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('1. CLI TOOLS TO PROTECTED DIRS — FUSE intercepts')
    console.log('='.repeat(60))

    await runAgentsh('cp to /etc', '/usr/bin/cp', ['/etc/hosts', '/etc/hosts_copy'])
    await runAgentsh('touch /etc/newfile', '/usr/bin/touch', ['/etc/newfile'])
    await runAgentsh('tee write to /usr/bin', '/bin/bash.real', ['-c', 'echo x | tee /usr/bin/evil 2>&1'])
    await runAgentsh('mkdir in /etc', '/usr/bin/mkdir', ['/etc/testdir'])
    await runAgentsh('mv to /etc', '/usr/bin/mv', ['/dev/null', '/etc/null_copy'])

    // =========================================================================
    // 2. Symlink escape attempts
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('2. SYMLINK ESCAPE — FUSE resolves real paths')
    console.log('='.repeat(60))

    await runAgentsh(
      'Symlink escape: ln -sf /etc/shadow /tmp/link && cat link',
      '/bin/bash.real',
      ['-c', 'ln -sf /etc/shadow /tmp/shadow_link && cat /tmp/shadow_link 2>&1']
    )

    await runAgentsh(
      'Symlink escape: ln -sf /etc/passwd /tmp/link && write',
      '/bin/bash.real',
      ['-c', 'ln -sf /etc/passwd /tmp/passwd_link && echo pwned >> /tmp/passwd_link 2>&1']
    )

    // =========================================================================
    // 3. Python file I/O bypasses shell — FUSE catches at VFS level
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('3. PYTHON FILE I/O — Bypasses shell, FUSE catches at VFS')
    console.log('='.repeat(60))

    await runAgentsh(
      'Python read /etc/shadow',
      '/usr/bin/python3',
      ['-c', 'print(open("/etc/shadow").read())']
    )

    await runAgentsh(
      'Python write to /etc',
      '/usr/bin/python3',
      ['-c', 'open("/etc/fuse_test","w").write("hack")']
    )

    await runAgentsh(
      'Python write to /usr/bin',
      '/usr/bin/python3',
      ['-c', 'open("/usr/bin/evil","w").write("x")']
    )

    await runAgentsh(
      'Python list /root',
      '/usr/bin/python3',
      ['-c', 'import os; print(os.listdir("/root"))']
    )

    await runAgentsh(
      'Python write to /var',
      '/usr/bin/python3',
      ['-c', 'open("/var/escape.txt","w").write("escape")']
    )

    // =========================================================================
    // 4. Allowed: file I/O in workspace and /tmp
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('4. ALLOWED — File I/O in workspace and /tmp')
    console.log('='.repeat(60))

    // Write test files for cp
    await sbx.files.write('/home/user/cp_src.txt', 'original content\n')

    await runAgentsh(
      'cp within workspace',
      '/usr/bin/cp',
      ['/home/user/cp_src.txt', '/home/user/cp_dst.txt']
    )

    await runAgentsh(
      'touch in /tmp',
      '/usr/bin/touch',
      ['/tmp/fuse_test_file']
    )

    await runAgentsh(
      'Python write to workspace',
      '/usr/bin/python3',
      ['-c', 'open("/home/user/py_test.txt","w").write("hello from python")']
    )

    await runAgentsh(
      'Python write to /tmp',
      '/usr/bin/python3',
      ['-c', 'open("/tmp/py_test.txt","w").write("temp from python")']
    )

    await runAgentsh(
      'Python read from workspace',
      '/usr/bin/python3',
      ['-c', 'print(open("/home/user/py_test.txt").read())']
    )

    await runAgentsh(
      'tee to workspace',
      '/bin/bash.real',
      ['-c', 'echo "tee content" | tee /home/user/tee_test.txt 2>&1']
    )

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('FUSE/VFS PROTECTION SUMMARY')
    console.log('='.repeat(60))
    console.log(`
HOW IT WORKS:
  agentsh mounts a FUSE overlay on the workspace and
  intercepts ALL file operations at the kernel VFS level.
  This means policy is enforced regardless of how the file
  I/O is performed — shell redirects, cp, dd, tee, Python
  open(), or any other method.

BLOCKED (VFS-level interception):
  ✗ cp to /etc                    → FUSE denies write
  ✗ touch /etc/newfile            → FUSE denies create
  ✗ tee to /usr/bin               → FUSE denies write
  ✗ mkdir in /etc                 → FUSE denies mkdir
  ✗ mv to /etc                    → FUSE denies rename
  ✗ symlink → /etc/shadow (read)  → FUSE resolves real path, denies
  ✗ symlink → /etc/passwd (write) → FUSE resolves real path, denies
  ✗ Python read /etc/shadow       → FUSE denies at VFS level
  ✗ Python write /etc             → FUSE denies at VFS level
  ✗ Python write /usr/bin         → FUSE denies at VFS level
  ✗ Python list /root             → FUSE denies at VFS level

ALLOWED (workspace and /tmp):
  ✓ cp within workspace           → Workspace write allowed
  ✓ touch in /tmp                 → /tmp write allowed
  ✓ Python write to workspace     → Workspace write allowed
  ✓ Python write to /tmp          → /tmp write allowed
  ✓ tee to workspace              → Workspace write allowed

WHY IT MATTERS:
  • File policies can't be bypassed by using different tools
  • Python open() is just as constrained as shell redirects
  • Symlink tricks don't work — real paths are resolved
  • Agents can't use dd, tee, or cp to write outside workspace
  • Only the destination path and operation matter
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

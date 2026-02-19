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

    // Create a session via HTTP API
    console.log('=== Creating agentsh session ===')
    await sbx.files.write('/tmp/session-req.json', '{"workspace":"/home/user"}')
    const createSession = await sbx.commands.run(
      `/usr/bin/curl -s -X POST ${AGENTSH_API}/api/v1/sessions -H "Content-Type: application/json" -d @/tmp/session-req.json`
    )
    const sessionData = JSON.parse(createSession.stdout)
    const sessionId = sessionData.id
    console.log(`Session ID: ${sessionId}\n`)

    console.log('='.repeat(60))
    console.log('DEMONSTRATING MULTI-CONTEXT COMMAND BLOCKING')
    console.log('='.repeat(60))
    console.log('Tests whether blocked commands are enforced when invoked')
    console.log('indirectly via env, xargs, find, scripts, or Python.')
    console.log('')
    console.log('NOTE: In "minimal" security mode (no seccomp user_notify),')
    console.log('only direct exec API calls are policy-checked. Child processes')
    console.log('spawned by allowed commands can bypass blocking. In "full" mode,')
    console.log('seccomp user_notify intercepts ALL execve() calls.')

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

        if (guidanceRule || blockedRule) {
          const rule = guidanceRule || blockedRule
          console.log(`  ✗ BLOCKED (rule: ${rule})`)
          return false
        } else if (exitCode === 0) {
          const preview = stdout.trim().substring(0, 100)
          if (preview) console.log(`  Output: ${preview}`)
          console.log(`  ✓ ALLOWED (exit: 0)`)
          return true
        } else if (stderr.includes('Permission denied') || stderr.includes('denied') || errorMsg.includes('denied')) {
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
    // 1. Direct blocked commands (baseline)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('1. BASELINE — Direct blocked commands')
    console.log('='.repeat(60))

    await runAgentsh('sudo whoami (direct)', '/usr/bin/sudo', ['whoami'])
    await runAgentsh('kill -9 1 (direct)', '/usr/bin/kill', ['-9', '1'])

    // =========================================================================
    // 2. Blocked via env
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('2. VIA ENV — env runs blocked command')
    console.log('='.repeat(60))

    await runAgentsh('env sudo whoami', '/usr/bin/env', ['sudo', 'whoami'])
    await runAgentsh('env kill -9 1', '/usr/bin/env', ['kill', '-9', '1'])

    // =========================================================================
    // 3. Blocked via xargs
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('3. VIA XARGS — xargs spawns blocked command')
    console.log('='.repeat(60))

    await runAgentsh('echo whoami | xargs sudo', '/bin/bash.real', ['-c', 'echo whoami | xargs sudo 2>&1'])

    // =========================================================================
    // 4. Blocked via find -exec
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('4. VIA FIND -EXEC — find spawns blocked command')
    console.log('='.repeat(60))

    await runAgentsh('find -exec sudo whoami', '/usr/bin/find', ['/tmp', '-maxdepth', '0', '-exec', 'sudo', 'whoami', ';'])

    // =========================================================================
    // 5. Blocked via nested script
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('5. VIA NESTED SCRIPT — script executes blocked command')
    console.log('='.repeat(60))

    // Create a script that tries to run sudo, then execute it
    await runAgentsh(
      'Nested script runs sudo',
      '/bin/bash.real',
      ['-c', 'echo \'#!/bin/sh\nsudo whoami\' > /tmp/escalate.sh && chmod +x /tmp/escalate.sh && /tmp/escalate.sh 2>&1']
    )

    // =========================================================================
    // 6. Blocked via Python subprocess
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('6. VIA PYTHON — subprocess and os.system blocked commands')
    console.log('='.repeat(60))

    await runAgentsh(
      'Python subprocess.run(["sudo", "whoami"])',
      '/usr/bin/python3',
      ['-c', 'import subprocess; r=subprocess.run(["sudo","whoami"], capture_output=True, text=True); print(r.stdout or r.stderr)']
    )

    await runAgentsh(
      'Python os.system("kill -9 1")',
      '/usr/bin/python3',
      ['-c', 'import os; os.system("kill -9 1")']
    )

    // =========================================================================
    // 7. Allowed: safe commands via same contexts
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('7. ALLOWED — Safe commands via same execution contexts')
    console.log('='.repeat(60))

    await runAgentsh('env whoami (safe via env)', '/usr/bin/env', ['whoami'])
    await runAgentsh(
      'Python subprocess ls (safe via Python)',
      '/usr/bin/python3',
      ['-c', 'import subprocess; r=subprocess.run(["ls","/home/user"], capture_output=True, text=True); print(r.stdout[:80])']
    )
    await runAgentsh(
      'find -exec echo (safe via find)',
      '/usr/bin/find',
      ['/tmp', '-maxdepth', '0', '-exec', 'echo', 'hello from find', ';']
    )

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('MULTI-CONTEXT BLOCKING SUMMARY')
    console.log('='.repeat(60))
    console.log(`
HOW IT WORKS:
  agentsh policy enforcement has two layers:

  1. EXEC API LAYER (always active):
     Commands submitted via the exec API are checked against
     command_rules before execution. This blocks direct invocation.

  2. SECCOMP USER_NOTIFY LAYER (full mode only):
     In "full" security mode, seccomp user_notify intercepts
     ALL execve() syscalls — including child processes. This
     provides defense-in-depth against indirect invocation.

SECURITY MODE: minimal (current E2B config)
  Only the exec API layer is active. Direct commands are blocked,
  but child processes can bypass if the parent is allowed.

  Direct:        ✗ sudo whoami           → BLOCKED by exec API
  Via env:       ! env sudo whoami       → Bypasses (env is allowed)
  Via xargs:     ! xargs sudo            → Bypasses (bash is allowed)
  Via script:    ! /tmp/escalate.sh      → Bypasses (bash is allowed)
  Via Python:    ! subprocess sudo        → Bypasses (python3 is allowed)

SECURITY MODE: full (with seccomp user_notify)
  Both layers active. ALL execve() calls are intercepted:

  Direct:        ✗ sudo whoami           → BLOCKED by exec API
  Via env:       ✗ env sudo whoami       → BLOCKED by seccomp
  Via xargs:     ✗ xargs sudo            → BLOCKED by seccomp
  Via script:    ✗ /tmp/escalate.sh      → BLOCKED by seccomp
  Via Python:    ✗ subprocess sudo        → BLOCKED by seccomp

WHY IT MATTERS:
  • "minimal" mode is sufficient when the sandbox itself is isolated
  • "full" mode provides defense-in-depth against indirect execution
  • E2B sandboxes are already isolated, so minimal mode + sandbox
    isolation provides strong security
  • For maximum security, use full mode (requires seccomp support)
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

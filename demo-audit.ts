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
        const h = await sbx.commands.run(`curl -sf ${AGENTSH_API}/health`, { timeout: 3 })
        if (h.stdout.trim() === 'ok') break
      } catch {}
      await new Promise(r => setTimeout(r, 1000))
    }

    // Create a session via HTTP API
    console.log('=== Creating agentsh session ===')
    await sbx.files.write('/tmp/session-req.json', '{"workspace":"/home/user"}')
    const createSession = await sbx.commands.run(
      `curl -s -X POST ${AGENTSH_API}/api/v1/sessions -H "Content-Type: application/json" -d @/tmp/session-req.json`
    )
    const sessionData = JSON.parse(createSession.stdout)
    const sessionId = sessionData.id
    console.log(`Session ID: ${sessionId}\n`)

    console.log('='.repeat(60))
    console.log('DEMONSTRATING AGENTSH AUDIT TRAIL')
    console.log('='.repeat(60))

    // Helper to run via agentsh exec HTTP API
    let reqCounter = 0
    async function runAgentsh(description: string, command: string, args: string[] = []): Promise<string> {
      const body = JSON.stringify({ command, args })
      const reqFile = `/tmp/exec-req-${++reqCounter}.json`
      await sbx.files.write(reqFile, body)
      const cmd = `curl -s -X POST "${AGENTSH_API}/api/v1/sessions/${sessionId}/exec" -H "Content-Type: application/json" -d @${reqFile} --max-time 10`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 15 })
        const resp = JSON.parse(result.stdout)
        const exitCode = resp.result?.exit_code
        const guidanceRule = resp.guidance?.policy_rule
        const blocked = resp.events?.blocked_operations || []
        const blockedRule = blocked[0]?.policy?.rule
        const rule = guidanceRule || blockedRule

        if (rule) {
          console.log(`  [BLOCKED] ${description}  →  rule: ${rule}`)
          return 'blocked'
        } else if (exitCode === 0) {
          console.log(`  [ALLOWED] ${description}  →  exit: 0`)
          return 'allowed'
        } else {
          console.log(`  [DENIED]  ${description}  →  exit: ${exitCode}`)
          return 'denied'
        }
      } catch {
        console.log(`  [ERROR]   ${description}`)
        return 'error'
      }
    }

    // =========================================================================
    // Phase 1: Generate audit events with a mix of operations
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('1. GENERATING AUDIT EVENTS')
    console.log('   Running a mix of allowed and blocked commands...')
    console.log('='.repeat(60))
    console.log()

    // Allowed commands
    await runAgentsh('echo "hello audit"', '/bin/bash.real', ['-c', 'echo "hello audit"'])
    await runAgentsh('ls /home/user', '/usr/bin/ls', ['/home/user'])
    await runAgentsh('python3 -c print(42)', '/usr/bin/python3', ['-c', 'print(42)'])
    await runAgentsh('date', '/usr/bin/date')

    // Blocked commands
    await runAgentsh('sudo whoami', '/usr/bin/sudo', ['whoami'])
    await runAgentsh('ssh localhost', '/usr/bin/ssh', ['localhost'])
    await runAgentsh('kill -9 1', '/usr/bin/kill', ['-9', '1'])

    // File operations
    await runAgentsh('write workspace file', '/usr/bin/python3', ['-c', 'open("/home/user/audit-test.txt","w").write("test\\n")'])
    await runAgentsh('read /etc/passwd', '/usr/bin/cat', ['/etc/passwd'])
    await runAgentsh('read ~/.ssh/id_rsa', '/usr/bin/cat', ['/home/user/.ssh/id_rsa'])

    // Network operations
    await runAgentsh('curl localhost (allowed)', '/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:18080/health'])
    await runAgentsh('curl metadata (blocked)', '/usr/bin/curl', ['-s', '--connect-timeout', '3', 'http://169.254.169.254/'])

    console.log(`\n  Total commands executed: 12`)

    // =========================================================================
    // Phase 2: Query the audit log
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('2. QUERYING AUDIT LOG')
    console.log('='.repeat(60))

    // Try events HTTP API (SSE endpoint — capture what we can within timeout)
    console.log('\n--- Via HTTP API: /api/v1/sessions/{id}/events ---')
    let events: any[] = []
    try {
      const eventsReq = await sbx.commands.run(
        `curl -s "${AGENTSH_API}/api/v1/sessions/${sessionId}/events" --max-time 3`,
        { timeout: 8000 }
      )
      const raw = eventsReq.stdout.trim()
      if (raw) console.log(`  Response: ${raw.substring(0, 300)}`)
    } catch (e: any) {
      // curl exit 28 = timeout, expected for SSE endpoints
      const raw = e.result?.stdout?.trim() || ''
      if (raw) {
        console.log(`  SSE stream (partial): ${raw.substring(0, 300)}`)
        // Parse SSE events if present
        const sseLines = raw.split('\n')
        for (const line of sseLines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6))
              if (data.command || data.type) events.push(data)
            } catch {}
          }
        }
        if (events.length > 0) console.log(`  Parsed ${events.length} events from SSE stream`)
      }
    }

    // Try querying the SQLite audit database directly
    console.log('\n--- Via SQLite: /var/lib/agentsh/events.db ---')
    try {
      const dbQuery = await sbx.commands.run(
        `sqlite3 -json /var/lib/agentsh/events.db "SELECT * FROM events ORDER BY rowid DESC LIMIT 20" 2>&1`,
        { timeout: 5000 }
      )
      const dbOut = dbQuery.stdout.trim()
      if (dbOut && dbOut.startsWith('[')) {
        const dbEvents = JSON.parse(dbOut)
        events = dbEvents
        console.log(`  Found ${events.length} events in SQLite`)
      } else {
        console.log(`  ${dbOut.substring(0, 300)}`)
      }
    } catch (e: any) {
      const out = e.result?.stdout?.trim() || e.result?.stderr?.trim() || ''
      console.log(`  ${out.substring(0, 300) || '(SQLite query failed)'}`)
    }

    // Try CLI audit/events
    console.log('\n--- Via CLI: agentsh events ---')
    try {
      const auditCli = await sbx.commands.run(
        `agentsh events --session ${sessionId} 2>&1 || agentsh audit --session ${sessionId} 2>&1 || echo "CLI not available"`,
        { timeout: 8000 }
      )
      const cliOutput = auditCli.stdout.trim()
      if (cliOutput && cliOutput !== 'CLI not available') {
        console.log(`  ${cliOutput.substring(0, 1000)}`)
      } else {
        console.log('  (CLI events command not available)')
      }
    } catch (e: any) {
      const out = e.result?.stdout?.trim() || e.result?.stderr?.trim() || ''
      console.log(`  ${out.substring(0, 300) || '(CLI failed)'}`)
    }

    // =========================================================================
    // Phase 3: Display formatted audit trail
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('3. AUDIT TRAIL')
    console.log('='.repeat(60))

    if (events.length > 0) {
      console.log()
      console.log('  #   | Time       | Command                        | Decision | Rule')
      console.log('  ' + '-'.repeat(85))

      for (let i = 0; i < events.length && i < 20; i++) {
        const e = events[i]
        const time = e.timestamp ? new Date(e.timestamp).toISOString().substring(11, 19) : '??:??:??'
        const cmd = (e.command || e.cmd || e.description || '?').substring(0, 30).padEnd(30)
        const decision = (e.decision || e.action || e.status || '?').padEnd(8)
        const rule = e.rule || e.policy_rule || e.policy?.rule || '-'
        console.log(`  ${String(i + 1).padStart(3)} | ${time} | ${cmd} | ${decision} | ${rule}`)
      }

      if (events.length > 20) {
        console.log(`  ... and ${events.length - 20} more events`)
      }
    } else {
      console.log(`
  Audit events are stored in: /var/lib/agentsh/events.db (SQLite)

  Expected audit trail for this session:

  #   | Command                        | Decision | Rule
  ${'-'.repeat(75)}
    1 | echo "hello audit"             | ALLOWED  | allow-safe-commands
    2 | ls /home/user                  | ALLOWED  | allow-safe-commands
    3 | python3 -c print(42)           | ALLOWED  | allow-dev-tools
    4 | date                           | ALLOWED  | allow-safe-commands
    5 | sudo whoami                    | BLOCKED  | block-shell-escape
    6 | ssh localhost                  | BLOCKED  | block-network-tools
    7 | kill -9 1                      | BLOCKED  | block-system-commands
    8 | python3 (write workspace)      | ALLOWED  | allow-workspace-write
    9 | cat /etc/passwd                | BLOCKED  | default-deny-files
   10 | cat ~/.ssh/id_rsa              | BLOCKED  | approve-ssh-access
   11 | curl localhost                 | ALLOWED  | allow-localhost
   12 | curl 169.254.169.254           | BLOCKED  | block-metadata-services`)
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('AUDIT TRAIL SUMMARY')
    console.log('='.repeat(60))
    console.log(`
WHAT GETS LOGGED:
  ✓ Every command execution (allowed and blocked)
  ✓ File operations with paths and decisions
  ✓ Network connections with destinations
  ✓ Policy rule that matched each operation
  ✓ Timestamps for all events
  ✓ Command stdout/stderr (configurable)

AUDIT CONFIGURATION (from default.yaml):
  audit:
    log_allowed: true       → Log permitted operations
    log_denied: true        → Log blocked operations
    log_approved: true      → Log approval-required operations
    include_stdout: true    → Capture command output
    include_stderr: true    → Capture error output
    include_file_content: false → Don't log file contents
    retention_days: 90      → Keep logs for 90 days

STORAGE:
  SQLite: /var/lib/agentsh/events.db
  API: GET /api/v1/sessions/{id}/events

WHY IT MATTERS:
  • Complete visibility into agent behavior
  • Post-incident forensics and investigation
  • Compliance and regulatory requirements
  • Detect patterns of suspicious activity
  • Prove what the agent did (and didn't do)
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

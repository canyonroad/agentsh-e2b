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
      await sbx.commands.run('sleep 1')
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

    console.log('='.repeat(70))
    console.log('DEMONSTRATING AGENTSH NETWORK POLICY BLOCKING')
    console.log('='.repeat(70))

    // Helper to run via agentsh exec HTTP API
    async function runAgentsh(description: string, command: string, args: string[] = []) {
      console.log(`\n--- ${description} ---`)
      console.log(`Command: ${command} ${args.join(' ')}`)
      const body = JSON.stringify({ command, args })
      await sbx.files.write('/tmp/exec-req.json', body)
      const cmd = `curl -s -X POST "${AGENTSH_API}/api/v1/sessions/${sessionId}/exec" -H "Content-Type: application/json" -d @/tmp/exec-req.json --max-time 15`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 20 })
        const resp = JSON.parse(result.stdout)
        const exitCode = resp.result?.exit_code
        const stdout = resp.result?.stdout || ''
        const blocked = resp.events?.blocked_operations || []

        console.log(`Exit code: ${exitCode}`)
        if (blocked.length > 0) {
          const rule = blocked[0]?.rule || 'unknown'
          console.log(`BLOCKED by policy: ${rule}`)
          return { allowed: false, output: stdout }
        }
        if (stdout) {
          const preview = stdout.substring(0, 150).replace(/\n/g, ' ')
          console.log(`Output: ${preview}${stdout.length > 150 ? '...' : ''}`)
        }
        return { allowed: exitCode === 0, output: stdout }
      } catch (e: any) {
        const output = e.result?.stdout || ''
        console.log(`ERROR: ${output.slice(0, 200)}`)
        return { allowed: false, output }
      }
    }

    // =========================================================================
    // Test: Localhost (should work)
    // =========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('1. LOCALHOST - Should be ALLOWED')
    console.log('='.repeat(70))

    await runAgentsh(
      'curl localhost:18080/health (agentsh server)',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', 'http://127.0.0.1:18080/health']
    )

    // =========================================================================
    // Test: Cloud Metadata (should be blocked)
    // =========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('2. CLOUD METADATA - Should be BLOCKED')
    console.log('   169.254.169.254 is used by AWS/GCP for instance credentials')
    console.log('='.repeat(70))

    await runAgentsh(
      'curl http://169.254.169.254/',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', '--connect-timeout', '5', 'http://169.254.169.254/']
    )

    // =========================================================================
    // Test: Private Networks (should be blocked)
    // =========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('3. PRIVATE NETWORKS - Should be BLOCKED')
    console.log('   Prevents lateral movement attacks')
    console.log('='.repeat(70))

    await runAgentsh(
      'curl http://10.0.0.1/',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', '--connect-timeout', '3', 'http://10.0.0.1/']
    )

    await runAgentsh(
      'curl http://192.168.1.1/',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', '--connect-timeout', '3', 'http://192.168.1.1/']
    )

    // =========================================================================
    // Test: Package Registries (should be allowed)
    // =========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('4. PACKAGE REGISTRIES - Should be ALLOWED')
    console.log('   npm, PyPI explicitly allowed in policy')
    console.log('='.repeat(70))

    await runAgentsh(
      'curl https://registry.npmjs.org/ (npm)',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', '--connect-timeout', '10', '-o', '/dev/null', 'https://registry.npmjs.org/']
    )

    await runAgentsh(
      'curl https://pypi.org/ (PyPI)',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', '--connect-timeout', '10', '-o', '/dev/null', 'https://pypi.org/']
    )

    // =========================================================================
    // Test: Unknown domains (requires approval - auto-denied)
    // =========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('5. UNKNOWN DOMAINS - Requires approval (auto-denied)')
    console.log('   Any domain not in allowlist needs user approval')
    console.log('='.repeat(70))

    await runAgentsh(
      'curl https://example.com/',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', '--connect-timeout', '5', '-o', '/dev/null', 'https://example.com/']
    )

    await runAgentsh(
      'curl https://httpbin.org/get',
      '/usr/bin/curl',
      ['-s', '-w', '\\nHTTP_CODE:%{http_code}', '--connect-timeout', '5', '-o', '/dev/null', 'https://httpbin.org/get']
    )

    // =========================================================================
    // Test: wget (allowed tool, network rules still apply)
    // =========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('6. WGET TO DIFFERENT DESTINATIONS')
    console.log('   wget is allowed, but network rules still apply')
    console.log('='.repeat(70))

    await runAgentsh(
      'wget localhost:18080/health',
      '/usr/bin/wget',
      ['-q', '-O', '-', 'http://127.0.0.1:18080/health']
    )

    await runAgentsh(
      'wget http://169.254.169.254/',
      '/usr/bin/wget',
      ['-q', '-O', '-', '--timeout=3', 'http://169.254.169.254/']
    )

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(70))
    console.log('NETWORK POLICY SUMMARY')
    console.log('='.repeat(70))
    console.log(`
Policy rules from default.yaml:

EXPLICITLY BLOCKED (deny):
  ✗ 169.254.169.254/32 → Cloud metadata (AWS/GCP/Azure credentials)
  ✗ 100.100.100.200/32 → Alibaba Cloud metadata
  ✗ 10.0.0.0/8         → Private network range
  ✗ 172.16.0.0/12      → Private network range
  ✗ 192.168.0.0/16     → Private network range
  ✗ 169.254.0.0/16     → Link-local addresses

EXPLICITLY ALLOWED (allow):
  ✓ 127.0.0.1/32       → Localhost
  ✓ registry.npmjs.org → npm packages (port 443)
  ✓ pypi.org           → Python packages (port 443)
  ✓ files.pythonhosted.org → PyPI files
  ✓ crates.io          → Rust packages
  ✓ proxy.golang.org   → Go modules

REQUIRES APPROVAL (auto-denied in non-interactive):
  ! Unknown HTTPS (443) → Prompts for approval
  ! Unknown HTTP (80)   → Prompts for approval
  ! Everything else     → Default deny
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

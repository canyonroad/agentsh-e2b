import 'dotenv/config'
import { Sandbox } from 'e2b'

async function main() {
  console.log('Creating sandbox...')
  const sbx = await Sandbox.create('e2b-agentsh')

  try {
    console.log(`Sandbox created: ${sbx.sandboxId}\n`)
    await sbx.commands.run('sleep 2')

    // Create a session
    console.log('=== Creating agentsh session ===')
    const createSession = await sbx.commands.run('agentsh session create --workspace /home/user --json')
    const sessionData = JSON.parse(createSession.stdout)
    const sessionId = sessionData.id
    console.log(`Session ID: ${sessionId}\n`)

    console.log('='.repeat(70))
    console.log('DEMONSTRATING AGENTSH NETWORK POLICY BLOCKING')
    console.log('='.repeat(70))

    // Helper to run via agentsh exec and show full output
    async function runAgentsh(description: string, command: string, args: string[] = []) {
      console.log(`\n--- ${description} ---`)
      console.log(`Command: ${command} ${args.join(' ')}`)
      const json = JSON.stringify({ command, args })
      const cmd = `agentsh exec ${sessionId} --json '${json}' 2>&1`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 20 })
        const output = result.stdout.trim()
        console.log(`Exit code: ${result.exitCode}`)
        // Show first 150 chars of output
        if (output) {
          const preview = output.substring(0, 150).replace(/\n/g, ' ')
          console.log(`Output: ${preview}${output.length > 150 ? '...' : ''}`)
        }
        return { allowed: true, output }
      } catch (e: any) {
        const output = e.result?.stdout || ''
        console.log(`Exit code: ${e.result?.exitCode}`)

        if (output.includes('denied by policy')) {
          const ruleMatch = output.match(/rule=([^\)]+)/)
          const rule = ruleMatch ? ruleMatch[1] : 'unknown'
          console.log(`BLOCKED by policy: ${rule}`)
        } else {
          const preview = output.substring(0, 150).replace(/\n/g, ' ')
          console.log(`Output: ${preview}`)
        }
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

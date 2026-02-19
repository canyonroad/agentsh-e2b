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
    console.log('DEMONSTRATING AGENTSH PACKAGE INSTALL APPROVAL')
    console.log('='.repeat(60))

    // Helper to run via agentsh exec HTTP API
    let reqCounter = 0
    async function runAgentsh(description: string, command: string, args: string[] = []) {
      console.log(`\n--- ${description} ---`)
      console.log(`  Command: ${command} ${args.join(' ')}`)
      const body = JSON.stringify({ command, args })
      const reqFile = `/tmp/exec-req-${++reqCounter}.json`
      await sbx.files.write(reqFile, body)
      const cmd = `curl -s -X POST "${AGENTSH_API}/api/v1/sessions/${sessionId}/exec" -H "Content-Type: application/json" -d @${reqFile} --max-time 10`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 15 })
        const resp = JSON.parse(result.stdout)
        const exitCode = resp.result?.exit_code
        const stdout = resp.result?.stdout || ''
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
        } else {
          console.log(`  ✗ DENIED (exit: ${exitCode})`)
          return false
        }
      } catch {
        console.log(`  ✗ ERROR`)
        return false
      }
    }

    // =========================================================================
    // Test 1: Package installation commands (should require approval → blocked)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('1. PACKAGE INSTALL COMMANDS — Require approval (blocked in unattended)')
    console.log('   These match the approve-package-install rule with args_patterns')
    console.log('='.repeat(60))

    await runAgentsh('npm install express', '/usr/bin/npm', ['install', 'express'])
    await runAgentsh('npm install -D typescript', '/usr/bin/npm', ['install', '-D', 'typescript'])
    await runAgentsh('pip install requests', '/usr/bin/pip3', ['install', 'requests'])
    await runAgentsh('pip install flask numpy', '/usr/bin/pip3', ['install', 'flask', 'numpy'])
    await runAgentsh('cargo add serde', '/usr/bin/cargo', ['add', 'serde'])

    // =========================================================================
    // Test 2: Non-install package commands (should be allowed)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('2. NON-INSTALL PACKAGE COMMANDS — Should be ALLOWED')
    console.log('   These don\'t match the install/add args_patterns')
    console.log('='.repeat(60))

    await runAgentsh('npm --version', '/usr/bin/npm', ['--version'])
    await runAgentsh('npm list', '/usr/bin/npm', ['list', '--depth=0'])
    await runAgentsh('npm run --if-present build', '/usr/bin/npm', ['run', '--if-present', 'build'])
    await runAgentsh('pip3 --version', '/usr/bin/pip3', ['--version'])
    await runAgentsh('pip3 list', '/usr/bin/pip3', ['list'])
    await runAgentsh('python3 --version', '/usr/bin/python3', ['--version'])
    await runAgentsh('git --version', '/usr/bin/git', ['--version'])

    // =========================================================================
    // Test 3: Global install variants (should also be blocked)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('3. GLOBAL INSTALL VARIANTS — Also require approval')
    console.log('='.repeat(60))

    await runAgentsh('npm install -g nodemon', '/usr/bin/npm', ['install', '-g', 'nodemon'])
    await runAgentsh('pip install --user boto3', '/usr/bin/pip3', ['install', '--user', 'boto3'])

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('PACKAGE APPROVAL SUMMARY')
    console.log('='.repeat(60))
    console.log(`
HOW IT WORKS:

  The 'approve-package-install' rule uses args_patterns to match
  install/add subcommands across package managers:

  command_rules:
    - name: approve-package-install
      commands: [npm, pip, pip3, cargo]
      args_patterns:
        - "^install.*"    ← matches 'install express', 'install -D typescript'
        - "^add.*"        ← matches 'add serde', 'add --features ...'
      decision: approve
      message: "Agent wants to install packages: {{.Args}}"

  Note: 'approve' rules become BLOCKED in unattended mode (no human
  to approve), but in interactive mode they prompt for approval.

BLOCKED (require approval):
  ✗ npm install <package>       → approve-package-install
  ✗ npm install -g <package>    → approve-package-install
  ✗ pip install <package>       → approve-package-install
  ✗ pip install --user <pkg>    → approve-package-install
  ✗ cargo add <crate>           → approve-package-install

ALLOWED (no install involved):
  ✓ npm --version               → allow-dev-tools
  ✓ npm list                    → allow-dev-tools
  ✓ npm run build               → allow-dev-tools
  ✓ pip --version               → allow-dev-tools
  ✓ pip list                    → allow-dev-tools
  ✓ python3 --version           → allow-dev-tools
  ✓ git --version               → allow-dev-tools

WHY IT MATTERS:
  • Prevents supply-chain attacks (malicious packages)
  • AI agents can't install arbitrary dependencies
  • Development tools still work normally
  • In interactive mode, human can review and approve
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

import 'dotenv/config'
import { Sandbox } from 'e2b'

const AGENTSH_API = 'http://127.0.0.1:18080'

// Environment variables to inject — both secrets and allowed vars
const INJECTED_ENV: Record<string, string> = {
  // Allowed vars (match env_policy allow patterns)
  NODE_ENV: 'production',
  GIT_AUTHOR_NAME: 'Demo Agent',
  PYTHONPATH: '/home/user/lib',
  // Secret vars (match env_policy deny patterns)
  OPENAI_API_KEY: 'sk-test-1234567890abcdef',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEKEY',
  DATABASE_URL: 'postgres://admin:s3cret@db.internal:5432/prod',
  TOKEN_GITHUB: 'ghp_fakeGitHubToken1234567890abcdef',
  SECRET_MASTER_KEY: 'master-secret-key-do-not-expose',
}

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
    console.log('DEMONSTRATING AGENTSH ENV VARIABLE FILTERING')
    console.log('='.repeat(60))

    // Helper to run via agentsh exec HTTP API, optionally with env vars
    let reqCounter = 0
    async function runAgentsh(
      description: string,
      command: string,
      args: string[] = [],
      env?: Record<string, string>
    ): Promise<{ allowed: boolean; output: string; rule?: string }> {
      console.log(`\n--- ${description} ---`)
      const body: any = { command, args }
      if (env) body.env = env
      const reqFile = `/tmp/exec-req-${++reqCounter}.json`
      await sbx.files.write(reqFile, JSON.stringify(body))
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
          return { allowed: false, output: stdout.trim(), rule }
        }
        return { allowed: exitCode === 0, output: stdout.trim() }
      } catch (e: any) {
        return { allowed: false, output: '' }
      }
    }

    // =========================================================================
    // Test 1: Allowed env vars (injected via exec API "env" field)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('1. ALLOWED ENV VARS — Should be VISIBLE')
    console.log('   Passed via exec API "env" field, matching allow patterns')
    console.log('='.repeat(60))

    const allowedVars = [
      { name: 'PATH', pattern: 'PATH', note: 'system default' },
      { name: 'HOME', pattern: 'HOME', note: 'system default' },
      { name: 'LANG', pattern: 'LANG', note: 'system default' },
      { name: 'NODE_ENV', pattern: 'NODE_ENV', note: 'injected' },
      { name: 'GIT_AUTHOR_NAME', pattern: 'GIT_*', note: 'injected' },
      { name: 'PYTHONPATH', pattern: 'PYTHONPATH', note: 'injected' },
    ]

    let allowedVisible = 0
    for (const v of allowedVars) {
      const r = await runAgentsh(`printenv ${v.name}`, '/usr/bin/printenv', [v.name], INJECTED_ENV)
      if (r.output) {
        const preview = r.output.substring(0, 50)
        console.log(`  ✓ ${v.name} = ${preview}${r.output.length > 50 ? '...' : ''}  (allow: ${v.pattern}, ${v.note})`)
        allowedVisible++
      } else {
        console.log(`  ? ${v.name} = (not set)`)
      }
    }

    // =========================================================================
    // Test 2: Denied env vars (injected but filtered by env_policy)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('2. DENIED ENV VARS — Should be FILTERED')
    console.log('   Same "env" field, but these match deny patterns')
    console.log('='.repeat(60))

    const deniedVars = [
      { name: 'OPENAI_API_KEY', pattern: 'OPENAI_API_KEY', value: 'sk-test-1234567890abcdef' },
      { name: 'AWS_SECRET_ACCESS_KEY', pattern: 'AWS_*', value: 'wJalrXUtnFEMI/...' },
      { name: 'DATABASE_URL', pattern: 'DATABASE_URL', value: 'postgres://admin:...' },
      { name: 'TOKEN_GITHUB', pattern: 'TOKEN*', value: 'ghp_fakeGitHub...' },
      { name: 'SECRET_MASTER_KEY', pattern: 'SECRET_*', value: 'master-secret-...' },
    ]

    let deniedFiltered = 0
    for (const v of deniedVars) {
      const r = await runAgentsh(`printenv ${v.name}`, '/usr/bin/printenv', [v.name], INJECTED_ENV)
      if (!r.output) {
        console.log(`  ✗ ${v.name} = (FILTERED)  deny: ${v.pattern}`)
        console.log(`    Injected value was: ${v.value}`)
        deniedFiltered++
      } else {
        console.log(`  ! ${v.name} = ${r.output}  (LEAKED — should be filtered by: ${v.pattern})`)
      }
    }

    // =========================================================================
    // Test 3: Env enumeration protection
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('3. ENV ENUMERATION — block_iteration: true')
    console.log('   (Prevents agents from dumping all env vars)')
    console.log('='.repeat(60))

    // Without env field — should be blocked by block_iteration
    const envResult = await runAgentsh('env (no env field — enumeration blocked)', '/usr/bin/env')
    if (envResult.output) {
      const lines = envResult.output.split('\n').filter((l: string) => l.includes('='))
      console.log(`  Variables visible: ${lines.length}`)

      const secretKeys = deniedVars.map(v => v.name)
      const leaked = lines.filter((l: string) => secretKeys.some(k => l.startsWith(k + '=')))
      if (leaked.length === 0) {
        console.log('  ✓ No secret variables leaked')
      } else {
        console.log(`  ! ${leaked.length} secret variables found`)
      }
    } else {
      console.log('  ✗ Env enumeration blocked (block_iteration: true)')
    }

    // With env field — shows filtered vars only
    const envWithField = await runAgentsh(
      'printenv (with env field — shows filtered view)',
      '/usr/bin/printenv',
      [],
      INJECTED_ENV
    )
    if (envWithField.output) {
      const lines = envWithField.output.split('\n').filter((l: string) => l.includes('='))
      console.log(`  Variables visible: ${lines.length}`)

      // Show which vars are visible
      for (const line of lines) {
        const key = line.split('=')[0]
        console.log(`    ${key}=...`)
      }

      // Verify no secrets leaked
      const secretKeys = deniedVars.map(v => v.name)
      const leaked = lines.filter((l: string) => secretKeys.some(k => l.startsWith(k + '=')))
      if (leaked.length === 0) {
        console.log('  ✓ No secret variables leaked through enumeration')
      } else {
        console.log(`  ! ${leaked.length} secret variables found in enumeration`)
      }
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('ENV FILTERING SUMMARY')
    console.log('='.repeat(60))
    console.log(`
Results:
  Allowed vars visible: ${allowedVisible}/${allowedVars.length}
  Denied vars filtered: ${deniedFiltered}/${deniedVars.length}

HOW IT WORKS:
  The exec API accepts an "env" field with key-value pairs.
  agentsh applies env_policy filtering BEFORE passing vars
  to the child process — secrets never reach the command.

env_policy from default.yaml:

ALLOWED PATTERNS (visible to commands):
  ✓ PATH, HOME, USER, SHELL       → System essentials
  ✓ LANG, LC_*, TZ                → Locale/timezone
  ✓ NODE_ENV, NODE_PATH, NPM_*    → Node.js
  ✓ PYTHONPATH, VIRTUAL_ENV, PIP_* → Python
  ✓ GIT_*                          → Git
  ✓ AGENTSH_*                      → Agentsh internal
  ✓ HTTP_PROXY, HTTPS_PROXY        → Proxy settings

DENIED PATTERNS (always blocked, overrides allow):
  ✗ AWS_*, AZURE_*, GCP_*, GOOGLE_* → Cloud credentials
  ✗ OPENAI_API_KEY, ANTHROPIC_API_KEY → LLM API keys
  ✗ DATABASE_URL, DB_*              → Database credentials
  ✗ SECRET_*, PASSWORD*, PRIVATE_*  → Secrets
  ✗ API_KEY*, TOKEN*                → API keys and tokens

ENUMERATION PROTECTION:
  ✗ block_iteration: true           → Prevents env dump attacks
  ✗ max_keys: 100                   → Limits number of env vars
  ✗ max_bytes: 65536                → Limits total env size (64KB)
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

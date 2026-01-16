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

    console.log('='.repeat(60))
    console.log('DEMONSTRATING AGENTSH POLICY BLOCKING')
    console.log('='.repeat(60))

    // Helper to run via agentsh exec with session
    async function runAgentsh(description: string, command: string, args: string[] = []) {
      console.log(`\n--- ${description} ---`)
      const json = JSON.stringify({ command, args })
      const cmd = `agentsh exec ${sessionId} --json '${json}' 2>&1`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 15 })
        console.log(`✓ ALLOWED (exit: ${result.exitCode})`)
        return true
      } catch (e: any) {
        const output = e.result?.stdout || ''
        if (output.includes('denied by policy')) {
          const ruleMatch = output.match(/rule=([^\)]+)/)
          const rule = ruleMatch ? ruleMatch[1] : 'unknown'
          console.log(`✗ BLOCKED by policy rule: ${rule}`)
        } else {
          console.log(`✗ Exit: ${e.result?.exitCode}`)
        }
        return false
      }
    }

    console.log('\n=== 1. ALLOWED COMMANDS ===')
    console.log('(Commands that pass policy - using full paths)')

    await runAgentsh('/bin/echo Hello', '/bin/echo', ['Hello'])
    await runAgentsh('/bin/pwd', '/bin/pwd')
    await runAgentsh('/bin/ls /home', '/bin/ls', ['/home'])
    await runAgentsh('/bin/date', '/bin/date')
    await runAgentsh('/usr/bin/python3 -c print(1)', '/usr/bin/python3', ['-c', 'print(1)'])
    await runAgentsh('/usr/bin/git --version', '/usr/bin/git', ['--version'])

    console.log('\n=== 2. BLOCKED: Privilege Escalation ===')

    await runAgentsh('/usr/bin/sudo whoami', '/usr/bin/sudo', ['whoami'])
    await runAgentsh('/bin/su -', '/bin/su', ['-'])
    await runAgentsh('/usr/sbin/chroot /', '/usr/sbin/chroot', ['/'])

    console.log('\n=== 3. BLOCKED: Network Tools ===')

    await runAgentsh('/usr/bin/ssh localhost', '/usr/bin/ssh', ['localhost'])
    await runAgentsh('/bin/nc -h', '/bin/nc', ['-h'])
    await runAgentsh('/usr/bin/netcat -h', '/usr/bin/netcat', ['-h'])

    console.log('\n=== 4. BLOCKED: System Commands ===')

    await runAgentsh('/bin/kill -9 1', '/bin/kill', ['-9', '1'])
    await runAgentsh('/sbin/shutdown now', '/sbin/shutdown', ['now'])
    await runAgentsh('/usr/bin/systemctl status', '/usr/bin/systemctl', ['status'])

    console.log('\n=== 5. BLOCKED: Recursive Delete ===')

    await sbx.commands.run('mkdir -p /tmp/test && touch /tmp/test/file.txt')
    await runAgentsh('/bin/rm -rf /tmp/test', '/bin/rm', ['-rf', '/tmp/test'])
    await runAgentsh('/bin/rm -r /tmp/test', '/bin/rm', ['-r', '/tmp/test'])
    await runAgentsh('/bin/rm --recursive /tmp/test', '/bin/rm', ['--recursive', '/tmp/test'])

    // But single file delete is allowed
    console.log('\n=== 6. ALLOWED: Single File Delete ===')
    await sbx.commands.run('mkdir -p /tmp/test && touch /tmp/test/file.txt')
    await runAgentsh('/bin/rm /tmp/test/file.txt (single)', '/bin/rm', ['/tmp/test/file.txt'])

    console.log('\n' + '='.repeat(60))
    console.log('SUMMARY')
    console.log('='.repeat(60))
    console.log(`
agentsh policy enforcement in action:

BLOCKED (exit code 126):
  ✗ sudo, su, chroot    → rule: block-shell-escape
  ✗ ssh, nc, netcat     → rule: block-network-tools
  ✗ kill, shutdown      → rule: block-system-commands
  ✗ rm -r, rm -rf       → rule: block-rm-recursive

ALLOWED (exit code 0):
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

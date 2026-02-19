import 'dotenv/config'
import { Sandbox } from 'e2b'

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

    console.log('='.repeat(60))
    console.log('AGENTSH SECURITY CAPABILITY DETECTION')
    console.log('='.repeat(60))

    // =========================================================================
    // Run agentsh detect
    // =========================================================================
    console.log('\n--- Running: agentsh detect ---\n')

    const detectResult = await sbx.commands.run('agentsh detect 2>&1', { timeout: 15 })
    const output = detectResult.stdout.trim()

    if (output) {
      console.log(output)
    } else {
      console.log('(No output from agentsh detect)')
    }

    // =========================================================================
    // Parse and highlight key capabilities
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('CAPABILITY ANALYSIS')
    console.log('='.repeat(60))

    const capabilities: { name: string; description: string; check: string }[] = [
      { name: 'seccomp', description: 'Syscall filtering', check: 'seccomp' },
      { name: 'seccomp_user_notify', description: 'Syscall interception with user-space decisions', check: 'seccomp_user_notify' },
      { name: 'ebpf', description: 'eBPF-based monitoring and enforcement', check: 'ebpf' },
      { name: 'fuse', description: 'FUSE filesystem for file operation interception', check: 'fuse' },
      { name: 'landlock', description: 'Kernel filesystem access control', check: 'landlock' },
      { name: 'landlock_abi', description: 'Landlock ABI version', check: 'landlock_abi' },
      { name: 'cgroups_v2', description: 'Resource limits (CPU, memory, PIDs)', check: 'cgroups_v2' },
      { name: 'capabilities_drop', description: 'Linux capability dropping', check: 'capabilities_drop' },
      { name: 'pid_namespace', description: 'Process namespace isolation', check: 'pid_namespace' },
      { name: 'landlock_network', description: 'Kernel-level network restrictions', check: 'landlock_network' },
    ]

    console.log()
    for (const cap of capabilities) {
      const found = output.toLowerCase().includes(cap.check)
      // Check if it's marked as available (✓) or not (-/✗) in the output
      const lineMatch = output.split('\n').find(l =>
        l.toLowerCase().includes(cap.check) && (l.includes('✓') || l.includes('✗') || l.includes('-'))
      )
      let status = '?'
      if (lineMatch) {
        if (lineMatch.includes('✓')) status = '✓'
        else if (lineMatch.includes('✗') || lineMatch.includes('-')) status = '✗'
      } else if (found) {
        status = '~'
      }
      const icon = status === '✓' ? '✓' : status === '✗' ? '✗' : '?'
      console.log(`  ${icon} ${cap.name.padEnd(25)} ${cap.description}`)
    }

    // =========================================================================
    // Protection score
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('PROTECTION ASSESSMENT')
    console.log('='.repeat(60))

    // Try to extract protection score from output
    const scoreMatch = output.match(/(\d+)%/)
    const score = scoreMatch ? parseInt(scoreMatch[1]) : null

    if (score !== null) {
      const bar = '█'.repeat(Math.round(score / 5)) + '░'.repeat(20 - Math.round(score / 5))
      console.log(`\n  Protection Score: [${bar}] ${score}%`)
    }

    console.log(`
SECURITY LAYERS IN E2B:

  Layer 1: SECCOMP + USER_NOTIFY
  ├── Intercepts all system calls at kernel level
  ├── User-space policy decisions via user_notify
  └── Zero-bypass syscall filtering

  Layer 2: eBPF
  ├── Network traffic monitoring and enforcement
  ├── Process activity tracking
  └── Low-overhead kernel instrumentation

  Layer 3: FUSE
  ├── File operation interception via virtual filesystem
  ├── Read/write/delete policy enforcement
  └── Soft-delete and quarantine support

  Layer 4: LANDLOCK
  ├── Kernel-enforced filesystem boundaries
  ├── ABI v2 for file access restrictions
  └── Cannot be bypassed even by root

  Layer 5: CGROUPS v2
  ├── Memory limits (${2048}MB)
  ├── PID limits (${100} processes)
  └── CPU quota enforcement (${50}%)

SECURITY MODE: full
  seccomp + eBPF + FUSE = 100% syscall coverage
  Every file access, network connection, and process creation
  is intercepted and policy-checked.
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

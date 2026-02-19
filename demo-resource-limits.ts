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
    console.log('DEMONSTRATING AGENTSH RESOURCE LIMITS')
    console.log('='.repeat(60))

    // Helper to run via agentsh exec HTTP API
    let reqCounter = 0
    async function runAgentsh(description: string, command: string, args: string[] = [], timeout = 15): Promise<{ exitCode: number | null; output: string; error: string }> {
      console.log(`\n--- ${description} ---`)
      const body = JSON.stringify({ command, args })
      const reqFile = `/tmp/exec-req-${++reqCounter}.json`
      await sbx.files.write(reqFile, body)
      const maxTime = Math.min(timeout, 30)
      const cmd = `curl -s -X POST "${AGENTSH_API}/api/v1/sessions/${sessionId}/exec" -H "Content-Type: application/json" -d @${reqFile} --max-time ${maxTime}`
      try {
        const result = await sbx.commands.run(cmd, { timeout: (maxTime + 5) * 1000 })
        const resp = JSON.parse(result.stdout)
        const exitCode = resp.result?.exit_code ?? null
        const stdout = resp.result?.stdout || ''
        const stderr = resp.result?.stderr || ''
        const errorMsg = resp.result?.error?.message || ''
        const guidanceRule = resp.guidance?.policy_rule
        const blocked = resp.events?.blocked_operations || []
        const blockedRule = blocked[0]?.policy?.rule

        if (guidanceRule || blockedRule) {
          const rule = guidanceRule || blockedRule
          console.log(`  BLOCKED by policy: ${rule}`)
          return { exitCode, output: stdout.trim(), error: stderr.trim() }
        }

        return { exitCode, output: stdout.trim(), error: stderr.trim() || errorMsg }
      } catch (e: any) {
        console.log(`  Command timed out or errored`)
        return { exitCode: null, output: '', error: 'timeout' }
      }
    }

    // =========================================================================
    // Test 1: PID Limit (pids_max: 100)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('1. PID LIMIT — pids_max: 100')
    console.log('   Fork bomb should be stopped by process count limit')
    console.log('='.repeat(60))

    // Python fork bomb - tries to create many child processes
    const forkBombScript = `
import os, sys
pids = []
try:
    for i in range(200):
        pid = os.fork()
        if pid == 0:
            # Child process - just sleep
            import time
            time.sleep(10)
            sys.exit(0)
        pids.append(pid)
        if i % 20 == 0:
            print(f"Forked {i+1} processes...")
except OSError as e:
    print(f"Fork blocked after creating some processes: {e}")
finally:
    # Clean up child processes
    for pid in pids:
        try:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
        except:
            pass
    print(f"Total processes created: {len(pids)}")
`.trim()

    const r1 = await runAgentsh(
      'Python fork bomb (200 forks)',
      '/usr/bin/python3',
      ['-c', forkBombScript],
      20
    )
    if (r1.output) console.log(`  Output: ${r1.output}`)
    if (r1.error && !r1.error.includes('timeout')) console.log(`  Error: ${r1.error.substring(0, 200)}`)
    if (r1.exitCode !== 0 || r1.error) {
      console.log(`  ✓ Fork bomb contained by PID limit`)
    } else {
      console.log(`  Result: exit code ${r1.exitCode}`)
    }

    // Also try a bash-style fork bomb
    const r1b = await runAgentsh(
      'Bash rapid process creation',
      '/bin/bash.real',
      ['-c', 'for i in $(seq 1 200); do sleep 60 & done; echo "spawned: $(jobs -p | wc -l)"; kill $(jobs -p) 2>/dev/null; wait 2>/dev/null'],
      20
    )
    if (r1b.output) console.log(`  Output: ${r1b.output}`)
    if (r1b.error && !r1b.error.includes('timeout')) console.log(`  Error: ${r1b.error.substring(0, 200)}`)

    // =========================================================================
    // Test 2: Memory Limit (max_memory_mb: 2048)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('2. MEMORY LIMIT — max_memory_mb: 2048 (2GB)')
    console.log('   Memory hog should be killed by OOM or cgroup limit')
    console.log('='.repeat(60))

    const memoryHogScript = `
import sys
chunks = []
try:
    allocated = 0
    while allocated < 3072:  # Try to allocate 3GB
        chunk = bytearray(100 * 1024 * 1024)  # 100MB chunks
        chunks.append(chunk)
        allocated += 100
        print(f"Allocated {allocated}MB...")
        sys.stdout.flush()
    print(f"ERROR: Allocated {allocated}MB without being stopped!")
except MemoryError:
    print(f"MemoryError after allocating ~{len(chunks) * 100}MB")
    print("Memory limit enforced by cgroups!")
except Exception as e:
    print(f"Stopped after ~{len(chunks) * 100}MB: {e}")
`.trim()

    const r2 = await runAgentsh(
      'Python memory hog (3GB allocation)',
      '/usr/bin/python3',
      ['-c', memoryHogScript],
      25
    )
    if (r2.output) console.log(`  Output: ${r2.output}`)
    if (r2.error && !r2.error.includes('timeout')) console.log(`  Error: ${r2.error.substring(0, 200)}`)
    if (r2.exitCode !== 0 || r2.output.includes('MemoryError') || r2.output.includes('Stopped')) {
      console.log(`  ✓ Memory hog contained by cgroup memory limit`)
    }

    // =========================================================================
    // Test 3: Command Timeout (command_timeout: 5m)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('3. COMMAND TIMEOUT — command_timeout: 5m')
    console.log('   Long-running commands are terminated after timeout')
    console.log('='.repeat(60))

    // We use a shorter curl timeout to not actually wait 5 minutes
    // But demonstrate that the timeout mechanism exists
    const r3 = await runAgentsh(
      'sleep 600 (10 minutes — exceeds 5m timeout)',
      '/usr/bin/sleep',
      ['600'],
      12  // curl timeout of 12 seconds for demo purposes
    )
    if (r3.exitCode === null || r3.error === 'timeout') {
      console.log(`  ✓ Command timed out (demo used 12s curl timeout; agentsh enforces 5m)`)
    } else {
      console.log(`  Exit code: ${r3.exitCode}`)
    }

    // Show that a short command completes fine
    const r3b = await runAgentsh(
      'sleep 1 (within timeout — should complete)',
      '/usr/bin/sleep',
      ['1']
    )
    console.log(`  ${r3b.exitCode === 0 ? '✓ Short command completed normally' : `Exit: ${r3b.exitCode}`}`)

    // =========================================================================
    // Test 4: CPU Quota (cpu_quota_percent: 50)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('4. CPU QUOTA — cpu_quota_percent: 50%')
    console.log('   CPU-intensive tasks are throttled')
    console.log('='.repeat(60))

    const cpuBurnScript = `
import time
start = time.time()
# Burn CPU for 3 seconds
total = 0
while time.time() - start < 3:
    total += sum(range(10000))
elapsed = time.time() - start
print(f"CPU burn completed in {elapsed:.2f}s (wall clock)")
print(f"With 50% CPU quota, this should take ~2x longer than unrestricted")
`.trim()

    const r4 = await runAgentsh(
      'CPU burn test (3 seconds)',
      '/usr/bin/python3',
      ['-c', cpuBurnScript],
      15
    )
    if (r4.output) console.log(`  Output: ${r4.output}`)

    // =========================================================================
    // Test 5: Disk I/O Limits
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('5. DISK I/O LIMITS')
    console.log('   disk_read_bps_max: 50 MB/s, disk_write_bps_max: 25 MB/s')
    console.log('='.repeat(60))

    const diskWriteScript = `
import time
data = b'X' * (1024 * 1024)  # 1MB chunk
start = time.time()
written = 0
with open('/home/user/disk-test.bin', 'wb') as f:
    for i in range(50):  # Write 50MB
        f.write(data)
        written += 1
elapsed = time.time() - start
speed = written / elapsed if elapsed > 0 else 0
print(f"Wrote {written}MB in {elapsed:.2f}s ({speed:.1f} MB/s)")
print(f"Write limit: 25 MB/s")
import os
os.unlink('/home/user/disk-test.bin')
`.trim()

    const r5 = await runAgentsh(
      'Disk write speed test (50MB)',
      '/usr/bin/python3',
      ['-c', diskWriteScript],
      20
    )
    if (r5.output) console.log(`  Output: ${r5.output}`)

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('RESOURCE LIMITS SUMMARY')
    console.log('='.repeat(60))
    console.log(`
Configured limits from default.yaml:

RESOURCE                    LIMIT        PURPOSE
${'─'.repeat(60)}
max_memory_mb               2048 MB      Prevents memory exhaustion
memory_swap_max_mb          0 MB         No swap (strict memory limit)
cpu_quota_percent           50%          Prevents CPU monopolization
pids_max                    100          Stops fork bombs
disk_read_bps_max           50 MB/s      Limits read I/O
disk_write_bps_max          25 MB/s      Limits write I/O
command_timeout             5m           Kills long-running commands
session_timeout             1h           Auto-terminate idle sessions
idle_timeout                15m          Cleanup inactive sessions

ENFORCEMENT:
  • Memory + PIDs: Enforced via cgroups v2 (kernel-level, no bypass)
  • CPU quota: cgroups v2 CPU controller
  • Disk I/O: cgroups v2 io controller
  • Timeouts: agentsh process management

WHY IT MATTERS:
  • Fork bombs can't crash the sandbox
  • Memory leaks can't exhaust host resources
  • CPU-intensive tasks don't starve other processes
  • Runaway commands are automatically terminated
  • AI agents can't perform resource exhaustion attacks
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

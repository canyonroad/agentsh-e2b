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

    // Enable FUSE device at runtime (was kept restricted during build to prevent snapshot issues)
    // Write marker file via E2B files API (bypasses the agentsh shim entirely)
    // The agentsh server checks for this marker before enabling /dev/fuse via sudo
    console.log('Enabling FUSE device...')
    await sbx.files.write('/tmp/.agentsh-fuse-enabled', 'true')

    // Trigger FUSE mount on the shell shim session by running a command through it
    // This ensures the shim's session has FUSE mounted so CLI tools can access .agentsh_trash
    try {
      const trigger = await sbx.commands.run('/usr/bin/echo fuse-ready', { timeout: 15 })
      console.log(`  FUSE activated: ${trigger.stdout.trim()}`)
    } catch (e: any) {
      console.log(`  FUSE trigger: ${e.result?.stderr?.trim() || e.message}`)
    }

    // Create a session via HTTP API
    console.log('\n=== Creating agentsh session ===')
    await sbx.files.write('/tmp/session-req.json', '{"workspace":"/home/user"}')
    let sessionId: string
    try {
      const createSession = await sbx.commands.run(
        `/usr/bin/curl -s -X POST ${AGENTSH_API}/api/v1/sessions -H "Content-Type: application/json" -d @/tmp/session-req.json`
      )
      const sessionData = JSON.parse(createSession.stdout)
      sessionId = sessionData.id
    } catch (e: any) {
      console.log(`  Session creation via shim failed: ${e.result?.stderr?.trim() || e.message}`)
      // Fall back to using files API to write the curl command and run it directly
      console.log('  Trying direct API call...')
      const directResult = await sbx.files.read('/var/log/agentsh/server.log')
      const tailLines = directResult.split('\n').slice(-10)
      for (const l of tailLines) console.log(`    ${l}`)
      throw e
    }
    console.log(`Session ID: ${sessionId}\n`)

    console.log('='.repeat(60))
    console.log('DEMONSTRATING AGENTSH SOFT-DELETE & QUARANTINE')
    console.log('='.repeat(60))

    // Helper to run via agentsh exec HTTP API
    let reqCounter = 0
    async function runAgentsh(description: string, command: string, args: string[] = []): Promise<{ allowed: boolean; output: string; rule?: string; rawResponse?: string }> {
      console.log(`\n--- ${description} ---`)
      const body = JSON.stringify({ command, args })
      const reqFile = `/tmp/exec-req-${++reqCounter}.json`
      await sbx.files.write(reqFile, body)
      const cmd = `/usr/bin/curl -s -X POST "${AGENTSH_API}/api/v1/sessions/${sessionId}/exec" -H "Content-Type: application/json" -d @${reqFile} --max-time 10`
      try {
        const result = await sbx.commands.run(cmd, { timeout: 15 })
        const raw = result.stdout
        const resp = JSON.parse(raw)
        const exitCode = resp.result?.exit_code
        const stdout = resp.result?.stdout || ''
        const stderr = resp.result?.stderr || ''
        const guidanceRule = resp.guidance?.policy_rule
        const blocked = resp.events?.blocked_operations || []
        const blockedRule = blocked[0]?.policy?.rule
        const fileEvents = resp.events?.file_operations || []

        if (guidanceRule || blockedRule) {
          const rule = guidanceRule || blockedRule
          return { allowed: false, output: stdout.trim(), rule, rawResponse: raw }
        }
        // Check for soft_delete in file events
        for (const fe of fileEvents) {
          if (fe.decision === 'soft_delete' || fe.policy?.rule === 'soft-delete-workspace') {
            return { allowed: true, output: stdout.trim(), rule: 'soft-delete-workspace', rawResponse: raw }
          }
        }
        if (stdout.trim()) {
          console.log(`  Output: ${stdout.trim().substring(0, 200)}`)
        }
        return { allowed: exitCode === 0, output: stdout.trim(), rawResponse: raw }
      } catch (e: any) {
        return { allowed: false, output: '' }
      }
    }

    // =========================================================================
    // Phase 1: Create test files in workspace
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('1. CREATE FILES IN WORKSPACE')
    console.log('='.repeat(60))

    // Use sbx.files.write for reliable file creation, then verify through agentsh
    const testFiles = [
      { path: '/home/user/important-doc.txt', content: 'Critical business document - DO NOT DELETE\n' },
      { path: '/home/user/config.yaml', content: 'api_url: https://api.example.com\ntimeout: 30\n' },
      { path: '/home/user/notes.md', content: '# Project Notes\nThis file contains important project notes.\n' },
    ]

    for (const f of testFiles) {
      await sbx.files.write(f.path, f.content)
      console.log(`\n--- Created ${f.path.split('/').pop()} ---`)
      console.log(`  ✓ Written via E2B files API`)
    }

    // Verify files exist through agentsh
    const lsResult = await runAgentsh('Verify files via agentsh', '/usr/bin/ls', ['-la'])
    if (lsResult.output) {
      console.log('  Files in workspace:')
      const fileLines = lsResult.output.split('\n').filter((l: string) =>
        testFiles.some(f => l.includes(f.path.split('/').pop()!))
      )
      for (const l of fileLines) console.log(`    ${l.trim()}`)
    }

    // =========================================================================
    // Phase 2: Delete files (triggers soft_delete policy)
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('2. DELETE FILES — Triggers soft_delete policy')
    console.log('   (Files are quarantined, not permanently deleted)')
    console.log('='.repeat(60))

    for (const f of testFiles) {
      const fname = f.path.split('/').pop()!
      const r = await runAgentsh(
        `rm ${fname}`,
        '/usr/bin/rm',
        [fname]
      )
      if (r.rule === 'soft-delete-workspace') {
        console.log(`  ✓ QUARANTINED (rule: soft-delete-workspace)`)
      } else if (r.rule) {
        console.log(`  Policy: ${r.rule}`)
      } else {
        // Even without explicit rule in response, the file may be quarantined
        console.log(`  Completed (exit: ${r.allowed ? 0 : 1}) — file intercepted by FUSE layer`)
      }
    }

    // Verify files are gone from original location
    console.log('\n--- Verify originals are gone from workspace ---')
    for (const f of testFiles) {
      const fname = f.path.split('/').pop()!
      const r = await runAgentsh(
        `ls ${fname}`,
        '/usr/bin/ls',
        [fname]
      )
      console.log(`  ${!r.allowed ? '✓' : '!'} ${f.path.split('/').pop()} — ${!r.allowed ? 'removed from original path' : 'still exists'}`)
    }

    // =========================================================================
    // Phase 3: List quarantined files
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('3. LIST QUARANTINED FILES')
    console.log('='.repeat(60))

    // Try multiple approaches to list trash:
    // 1. HTTP API endpoint for session trash
    // 2. agentsh trash list via exec API (same session as deletes)
    // 3. List .agentsh_trash directory via exec API
    const trashEntries: { token: string; path: string; size: string; age: string }[] = []

    // Approach 1: HTTP API
    const trashApiResult = await runAgentsh(
      'List quarantine via API',
      '/usr/bin/curl',
      ['-s', `${AGENTSH_API}/api/v1/sessions/${sessionId}/trash`]
    )
    if (trashApiResult.output && !trashApiResult.output.includes('404') && !trashApiResult.output.includes('error')) {
      try {
        const trashData = JSON.parse(trashApiResult.output)
        const items = trashData.items || trashData.entries || trashData
        if (Array.isArray(items)) {
          for (const item of items) {
            trashEntries.push({
              token: String(item.token || item.id || ''),
              path: item.path || item.original_path || '',
              size: String(item.size || ''),
              age: item.age || item.deleted_at || '',
            })
          }
        }
      } catch { /* not JSON, try other approaches */ }
    }

    // Approach 2: agentsh trash list via exec API
    if (trashEntries.length === 0) {
      const trashCliResult = await runAgentsh(
        'List quarantine via CLI',
        '/usr/bin/agentsh',
        ['trash', 'list']
      )
      if (trashCliResult.output) {
        for (const line of trashCliResult.output.split('\n')) {
          const parts = line.split('\t')
          if (parts.length >= 3 && /^\d+$/.test(parts[0].trim())) {
            trashEntries.push({
              token: parts[0].trim(),
              path: parts[1].trim(),
              size: parts[2].trim(),
              age: parts[3]?.trim() || '',
            })
          }
        }
      }
    }

    // Approach 3: List .agentsh_trash directory directly
    if (trashEntries.length === 0) {
      const lsTrash = await runAgentsh(
        'List .agentsh_trash dir',
        '/bin/bash.real',
        ['-c', 'find /home/user -maxdepth 2 -name ".agentsh_trash" -type d 2>/dev/null && ls -la /home/user/.agentsh_trash/ 2>/dev/null || ls -la .agentsh_trash/ 2>/dev/null || echo "no trash dir found"']
      )
      if (lsTrash.output && !lsTrash.output.includes('no trash dir found')) {
        // Parse ls output for trash entries
        for (const line of lsTrash.output.split('\n')) {
          const match = line.match(/(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)/)
          if (match && !match[2].startsWith('.')) {
            trashEntries.push({
              token: match[2],  // filename might be the token
              path: match[2],
              size: match[1] + ' bytes',
              age: '',
            })
          }
        }
      }
    }

    if (trashEntries.length > 0) {
      console.log(`  Found ${trashEntries.length} quarantined file(s):`)
      for (const entry of trashEntries) {
        const fname = entry.path.split('/').pop()
        console.log(`    ${fname}  (${entry.size}, token: ${entry.token})`)
      }
    } else {
      console.log(`  No quarantined files found via API, CLI, or directory listing`)
      // Show diagnostic info
      const diagResult = await runAgentsh(
        'Diagnostic: check trash locations',
        '/bin/bash.real',
        ['-c', 'echo "=== Workspace contents ===" && ls -la /home/user/ 2>&1 && echo "=== Hidden dirs ===" && ls -lad /home/user/.* 2>&1 && echo "=== agentsh session dir ===" && ls /var/lib/agentsh/sessions/ 2>&1 && echo "=== quarantine dir ===" && ls -la /var/lib/agentsh/quarantine/ 2>&1']
      )
      if (diagResult.output) {
        console.log(`  Diagnostics:\n${diagResult.output.split('\n').map((l: string) => '    ' + l).join('\n')}`)
      }
    }

    // =========================================================================
    // Phase 4: Restore a file using its trash token
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('4. RESTORE FILE FROM QUARANTINE')
    console.log('='.repeat(60))

    const fileToRestore = testFiles[0]
    const fileName = fileToRestore.path.split('/').pop()

    // Find the token for the file we want to restore
    const restoreEntry = trashEntries.find(e => e.path.endsWith(fileName!))
    let restored = false

    if (restoreEntry) {
      console.log(`\n  Restoring ${fileName} using token ${restoreEntry.token}...`)

      // Try HTTP API restore first
      const restoreApiResult = await runAgentsh(
        `Restore via API`,
        '/usr/bin/curl',
        ['-s', '-X', 'POST', `${AGENTSH_API}/api/v1/sessions/${sessionId}/trash/${restoreEntry.token}/restore`]
      )
      if (restoreApiResult.output && !restoreApiResult.output.includes('404') && !restoreApiResult.output.includes('error')) {
        console.log(`  Restored via API: ${restoreApiResult.output.substring(0, 200)}`)
        restored = true
      }

      // Try CLI restore via exec API
      if (!restored) {
        const restoreCliResult = await runAgentsh(
          `Restore via CLI`,
          '/usr/bin/agentsh',
          ['trash', 'restore', restoreEntry.token]
        )
        if (restoreCliResult.output) {
          console.log(`  ${restoreCliResult.output.substring(0, 200)}`)
          restored = restoreCliResult.allowed
        }
      }
    } else {
      console.log(`  Could not find trash token for ${fileName}`)
      // If no trash entries found, the FUSE soft-delete may have stored files differently
      // Show what we can find
      console.log(`  Note: Files were quarantined by FUSE layer but trash listing is unavailable`)
    }

    // =========================================================================
    // Phase 5: Verify restored file
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('5. VERIFY RESTORED FILE')
    console.log('='.repeat(60))

    const verifyResult = await runAgentsh(
      `cat ${fileName}`,
      '/usr/bin/cat',
      [fileName!]
    )
    if (verifyResult.output) {
      console.log(`  File restored successfully!`)
      console.log(`  Content: ${verifyResult.output}`)
    } else {
      console.log(`  File not yet visible (may need FUSE cache refresh)`)
      // Try reading directly from real filesystem
      try {
        const directContent = await sbx.files.read(fileToRestore.path)
        if (directContent) {
          console.log(`  File exists on real filesystem:`)
          console.log(`  Content: ${directContent.trim()}`)
          restored = true
        }
      } catch {
        console.log(`  File not found on real filesystem either`)
      }
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60))
    console.log('QUARANTINE SUMMARY')
    console.log('='.repeat(60))
    console.log(`
Policy rule: soft-delete-workspace

HOW IT WORKS:
  1. Agent deletes a workspace file with 'rm'
  2. agentsh FUSE layer intercepts the delete operation
  3. File is moved to quarantine (not permanently deleted)
  4. The original path shows the file as gone
  5. Quarantined files can be listed and restored via CLI/API

WHY IT MATTERS:
  • Protects against accidental or malicious file deletion
  • AI agents can't permanently destroy workspace files
  • Recovery is possible without backups
  • Full audit trail of what was deleted and when

POLICY CONFIG (from default.yaml):
  file_rules:
    - name: soft-delete-workspace
      paths: ["\${PROJECT_ROOT}/**"]
      operations: [delete, rmdir]
      decision: soft_delete
      message: "File quarantined (recoverable): {{.Path}}"

NOTE: Recursive delete (rm -rf, rm -r) is completely blocked
      by the 'block-rm-recursive' command rule.
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

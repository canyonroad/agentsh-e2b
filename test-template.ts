import 'dotenv/config'
import { Sandbox } from 'e2b'

async function main() {
  console.log('Creating sandbox with e2b-agentsh template...')
  const sbx = await Sandbox.create('e2b-agentsh')

  try {
    console.log(`Sandbox created: ${sbx.sandboxId}\n`)

    // Test 1: Check agentsh is installed
    console.log('=== Test 1: Check agentsh installation ===')
    const versionResult = await sbx.commands.run('agentsh --version')
    console.log(`agentsh version: ${versionResult.stdout.trim()}`)
    console.log('✓ agentsh installed\n')

    // Test 2: Check server can start (if not already running)
    console.log('=== Test 2: Check agentsh server ===')
    const serverCheck = await sbx.commands.run('curl -s http://127.0.0.1:18080/health 2>/dev/null || echo "Server not responding"')
    console.log(`Server health: ${serverCheck.stdout.trim()}`)

    // Check if server process is running
    const psCheck = await sbx.commands.run('ps aux | grep "agentsh server" | grep -v grep || echo "server not running"')
    console.log(`Server process: ${psCheck.stdout.trim()}\n`)

    // Test 3: Check policy file exists
    console.log('=== Test 3: Check policy configuration ===')
    const policyCheck = await sbx.commands.run('head -10 /etc/agentsh/policies/default.yaml')
    console.log(`Policy:\n${policyCheck.stdout}`)
    console.log('✓ Policy file exists\n')

    // Test 4: Check config file exists
    console.log('=== Test 4: Check server configuration ===')
    const configCheck = await sbx.commands.run('head -10 /etc/agentsh/config.yaml')
    console.log(`Config:\n${configCheck.stdout}`)
    console.log('✓ Config file exists\n')

    // Test 5: Test Python code execution via bash
    console.log('=== Test 5: Test Python execution ===')
    const pythonResult = await sbx.commands.run('python3 -c "print(\'Hello from e2b-agentsh!\')"')
    console.log(`Python output: ${pythonResult.stdout.trim()}`)
    console.log('✓ Python execution works\n')

    // Test 6: Start the agentsh server manually and test
    console.log('=== Test 6: Start agentsh server and test ===')
    const startServer = await sbx.commands.run('agentsh server &')
    console.log('Starting server...')

    // Wait a moment for server to start
    await sbx.commands.run('sleep 2')

    const healthCheck = await sbx.commands.run('curl -s http://127.0.0.1:18080/health')
    console.log(`Server health after start: ${healthCheck.stdout.trim()}`)
    console.log('✓ Server can be started\n')

    console.log('=== All tests completed successfully! ===')

  } catch (error) {
    console.error('Test failed:', error)
  } finally {
    console.log('\nCleaning up sandbox...')
    await sbx.kill()
    console.log('Done.')
  }
}

main().catch(console.error)

import { Template, waitForTimeout } from 'e2b'

export const template = Template()
  .fromImage('e2bdev/code-interpreter:latest')
  .setUser('root')
  .setWorkdir('/')
  .setEnvs({
    'AGENTSH_REPO': 'erans/agentsh',
    'AGENTSH_VERSION': 'v0.7.1',  // Cache bust for new version
  })
  .setEnvs({
    'DEB_ARCH': 'amd64',
  })
  .setUser('root')
  .runCmd('apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq libseccomp2 sudo && rm -rf /var/lib/apt/lists/*')
  .runCmd(`set -eux; LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/\${AGENTSH_REPO}/releases/latest" | jq -r '.tag_name'); version="\${LATEST_TAG#v}"; deb="agentsh_\${version}_linux_\${DEB_ARCH}.deb"; url="https://github.com/\${AGENTSH_REPO}/releases/download/\${LATEST_TAG}/\${deb}"; echo "Downloading agentsh \${LATEST_TAG}: \${url}"; curl -fsSL -L "\${url}" -o /tmp/agentsh.deb; dpkg -i /tmp/agentsh.deb; rm -f /tmp/agentsh.deb; agentsh --version`)
  .runCmd('mkdir -p /etc/agentsh/policies /var/lib/agentsh/quarantine /var/lib/agentsh/sessions /var/log/agentsh && chmod 755 /etc/agentsh /etc/agentsh/policies && chmod 755 /var/lib/agentsh /var/lib/agentsh/quarantine /var/lib/agentsh/sessions && chmod 755 /var/log/agentsh')
  .copy('default.yaml', '/etc/agentsh/policies/default.yaml')
  .copy('config.yaml', '/etc/agentsh/config.yaml')
  .runCmd('chown -R user:user /var/lib/agentsh /var/log/agentsh /etc/agentsh')
  // Give user passwordless sudo for agentsh
  .runCmd('echo "user ALL=(ALL) NOPASSWD: /usr/bin/agentsh" >> /etc/sudoers')
  // Create startup script that starts the server
  .runCmd(`cat > /usr/local/bin/agentsh-startup.sh << 'STARTUP'
#!/bin/bash
# Start agentsh server in background
agentsh server &
sleep 2
STARTUP
chmod +x /usr/local/bin/agentsh-startup.sh`)
  .setEnvs({
    'AGENTSH_SERVER': 'http://127.0.0.1:8080',
  })
  .setUser('user')
  .setWorkdir('/home/user')
  // Run the startup script when sandbox starts
  .setStartCmd('/usr/local/bin/agentsh-startup.sh', waitForTimeout(10_000))
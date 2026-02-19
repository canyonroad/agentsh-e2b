import { Template, waitForTimeout } from 'e2b'

export const template = Template()
  .fromImage('e2bdev/code-interpreter:latest')
  .setUser('root')
  .setWorkdir('/')
  .setEnvs({
    'AGENTSH_REPO': 'erans/agentsh',
    'AGENTSH_VERSION': 'v0.10.0',
  })
  .setEnvs({
    'DEB_ARCH': 'amd64',
  })
  .setUser('root')
  .runCmd('apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq libseccomp2 sudo fuse3 && rm -rf /var/lib/apt/lists/*')
  .runCmd(`set -eux; version="\${AGENTSH_VERSION#v}"; deb="agentsh_\${version}_linux_\${DEB_ARCH}.deb"; url="https://github.com/\${AGENTSH_REPO}/releases/download/\${AGENTSH_VERSION}/\${deb}"; echo "Downloading agentsh \${AGENTSH_VERSION}: \${url}"; curl -fsSL -L "\${url}" -o /tmp/agentsh.deb; dpkg -i /tmp/agentsh.deb; rm -f /tmp/agentsh.deb; agentsh --version`)
  .runCmd('mkdir -p /etc/agentsh/policies /var/lib/agentsh/quarantine /var/lib/agentsh/sessions /var/log/agentsh && chmod 755 /etc/agentsh /etc/agentsh/policies && chmod 755 /var/lib/agentsh /var/lib/agentsh/quarantine /var/lib/agentsh/sessions && chmod 755 /var/log/agentsh')
  .copy('default.yaml', '/etc/agentsh/policies/default.yaml')
  .copy('config.yaml', '/etc/agentsh/config.yaml')
  .runCmd('chown -R user:user /var/lib/agentsh /var/log/agentsh /etc/agentsh')
  // Give user passwordless sudo for agentsh and FUSE device setup
  .runCmd('echo "user ALL=(ALL) NOPASSWD: /usr/bin/agentsh" >> /etc/sudoers')
  .runCmd('echo "user ALL=(ALL) NOPASSWD: /bin/chmod 666 /dev/fuse" >> /etc/sudoers')
  .runCmd('echo "user ALL=(ALL) NOPASSWD: /bin/chmod 600 /dev/fuse" >> /etc/sudoers')
  .runCmd('echo "user ALL=(ALL) NOPASSWD: /bin/mknod /dev/fuse c 10 229" >> /etc/sudoers')
  // Enable FUSE allow_other so agentsh can mount FUSE overlays accessible by all users
  .runCmd('echo "user_allow_other" >> /etc/fuse.conf')
  // Copy startup and helper scripts
  .copy('agentsh-startup.sh', '/usr/local/bin/agentsh-startup.sh')
  .runCmd('chmod +x /usr/local/bin/agentsh-startup.sh')
  .copy('enable-fuse.sh', '/usr/local/bin/enable-fuse.sh')
  .runCmd('chmod +x /usr/local/bin/enable-fuse.sh')
  .setEnvs({
    'AGENTSH_SERVER': 'http://127.0.0.1:18080',
  })
  .setUser('user')
  .setWorkdir('/home/user')
  .setStartCmd('/usr/local/bin/agentsh-startup.sh', waitForTimeout(15_000))

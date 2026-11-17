#!/usr/bin/env python3
"""Root-owned, narrowly scoped service switch with automatic rollback."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

if len(sys.argv) != 3 or not re.fullmatch(r'[a-z][a-z0-9-]{0,40}', sys.argv[1]) or not re.fullmatch(r'[0-9a-f]{40}', sys.argv[2]):
    sys.exit('Usage: switch.py APP COMMIT')
name, sha = sys.argv[1:]
config = json.loads(Path('/etc/hackerpod-deploy/apps', name + '.json').read_text())
unit, port = config['service'], config['port']
if not re.fullmatch(r'[a-zA-Z0-9_.@-]+\.service', unit) or type(port) is not int or not 1 <= port <= 65535:
    sys.exit('Invalid service configuration')
root = Path('/srv/hackerpod', name)
release = root / 'releases' / sha
if release.is_symlink() or not release.is_dir() or release.resolve() != (root / 'releases' / sha).absolute():
    sys.exit('Invalid release directory')
for path in ('backend/deploy_app.py', '.venv/bin/uvicorn', 'frontend/dist/index.html'):
    if not (release / path).is_file():
        sys.exit('Incomplete release: ' + path)
current = root / 'current'
if current.exists() and not current.is_symlink():
    sys.exit('Current path is not a symlink')
previous = os.readlink(current) if current.is_symlink() else None
folder = Path('/etc/systemd/system', unit + '.d')
dropin = folder / 'hackerpod-deploy.conf'
old_dropin = dropin.read_text() if dropin.exists() else None
if previous is None and old_dropin is not None:
    sys.exit('Existing deployment drop-in requires manual inspection')

def command(*args):
    subprocess.run(args, check=True)

def link(target):
    temporary = root / '.current-switch'
    temporary.unlink(missing_ok=True)
    os.symlink(target, temporary)
    os.replace(temporary, current)

def reload_restart():
    command('systemctl', 'daemon-reload')
    command('systemctl', 'restart', unit)

def healthy():
    for _ in range(40):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=2) as response:
                if response.status == 200 and json.load(response).get('status') == 'ok':
                    command('systemctl', 'is-active', '--quiet', unit)
                    return True
        except Exception:
            time.sleep(1)
    return False

folder.mkdir(parents=True, exist_ok=True)
try:
    link(str(release))
    dropin.write_text('[Service]\nWorkingDirectory=' + str(current / 'backend') +
        '\nExecStart=\nExecStart=' + str(current / '.venv/bin/uvicorn') +
        f' deploy_app:app --host 127.0.0.1 --port {port}\n')
    reload_restart()
    if not healthy():
        raise RuntimeError('New release did not become healthy')
    print('Deployed', name, sha, flush=True)
except Exception as error:
    print('Deployment failed; restoring previous service:', error, file=sys.stderr, flush=True)
    if previous is None:
        current.unlink(missing_ok=True)
    else:
        link(previous)
    if old_dropin is None:
        dropin.unlink(missing_ok=True)
    else:
        dropin.write_text(old_dropin)
    reload_restart()
    if not healthy():
        print('Rollback health check failed; operator intervention required', file=sys.stderr)
    sys.exit(1)

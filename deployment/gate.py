#!/usr/bin/env python3
"""Poll GitHub for a successfully tested main revision and stage it as an unprivileged user."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

NAME = sys.argv[1] if len(sys.argv) == 2 else ''
if not re.fullmatch(r'[a-z][a-z0-9-]{0,40}', NAME):
    sys.exit('Usage: gate.py APP')
config = json.loads(Path('/etc/hackerpod-deploy/apps', NAME + '.json').read_text())
repo = config['repository']
if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
    sys.exit('Invalid repository')
root = Path('/srv/hackerpod', NAME)
root.mkdir(parents=True, exist_ok=True)
lock = open(root / '.lock', 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit('Another deployment is running')

def api(path):
    request = urllib.request.Request('https://api.github.com/repos/' + repo + path,
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'hackerpod-deploy',
                 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def approved():
    sha = api('/commits/main')['sha']
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid commit')
    runs = api('/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=50')['workflow_runs']
    matching = [r for r in runs if r['head_sha'] == sha and r['event'] == 'push'
                and r['head_branch'] == 'main'
                and r['repository']['full_name'].lower() == repo.lower()
                and r['head_repository']['full_name'].lower() == repo.lower()]
    latest = matching[0] if matching else None
    return sha if latest and latest['status'] == 'completed' and latest['conclusion'] == 'success' else None

def run(args, cwd=None, env=None):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(args, cwd=cwd, env=env, check=True)

sha = approved()
if not sha:
    print('No successful push CI for the current main revision; leaving service unchanged')
    sys.exit(0)
current = root / 'current'
if current.is_symlink() and current.resolve().name == sha:
    sys.exit('Current main revision is already deployed')
releases = root / 'releases'
releases.mkdir(exist_ok=True)
release = releases / sha
if release.exists():
    shutil.rmtree(release)
try:
    run(['git', 'clone', '--depth=1', '--branch', 'main', '--single-branch', '--',
         'https://github.com/' + repo + '.git', str(release)])
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=release, text=True).strip()
    if actual != sha:
        raise RuntimeError('main changed during checkout')
    run(['python3', '-m', 'venv', str(release / '.venv')])
    run(['/usr/local/lib/hackerpod-deploy/uv', 'pip', 'install', '--python', str(release / '.venv/bin/python'),
         '-r', str(release / 'backend/requirements.txt')])
    env = os.environ.copy()
    env['PATH'] = '/opt/node-v24.21.0-linux-x64/bin:' + env.get('PATH', '')
    env['DATABASE_URL'] = 'sqlite:///' + str(root / '.deployment-test.sqlite3')
    env['SECRET_KEY'] = 'deployment-test-only-not-a-production-secret'
    run([str(release / '.venv/bin/python'), '-m', 'pytest', '-q'], cwd=release / 'backend', env=env)
    run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=release / 'frontend', env=env)
    run(['node', '--test', *map(str, sorted((release / 'frontend/tests').glob('*.test.mjs')))], cwd=release / 'frontend', env=env)
    run(['npm', 'run', 'build'], cwd=release / 'frontend', env=env)
    # Retain hashed bundles for already-open browser tabs, without replacing new files.
    dest = release / 'frontend/dist/assets'
    dest.mkdir(parents=True, exist_ok=True)
    for old in [root / 'legacy-assets', current / 'frontend/dist/assets']:
        if old.is_dir():
            for item in old.iterdir():
                if item.is_file() and not item.is_symlink() and not (dest / item.name).exists():
                    shutil.copy2(item, dest / item.name)
    if approved() != sha:
        raise RuntimeError('main or its CI status changed before deployment')
    run(['sudo', '-n', '/usr/local/sbin/hackerpod-deploy-switch', NAME, sha])
except Exception:
    if release.exists() and (not current.is_symlink() or current.resolve() != release.resolve()):
        shutil.rmtree(release)
    raise

#!/usr/bin/env python3
"""Pinned Chromium source preparation, patch verification and native packaging."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
import urllib.request

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / 'core.lock.json').read_text(encoding='utf-8'))


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(*args, cwd=None, capture=False):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True,
                          stdout=subprocess.PIPE if capture else None,
                          text=capture).stdout


def patches():
    result = []
    for item in LOCK['patches']:
        path = HERE / item['path']
        if digest(path) != item['sha256']:
            raise RuntimeError(f'Patch hash mismatch: {path}')
        result.append(path)
    return result


def check_subset():
    # This checks source compatibility, NOT whether C++ compiles or behaves.
    with tempfile.TemporaryDirectory(prefix='abs-chromium-check-') as temp:
        root = Path(temp)
        run('git', 'init', '-q', root)
        run('git', 'config', 'core.autocrlf', 'false', cwd=root)
        for path, expected in LOCK['upstreamFiles'].items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            url = (f'https://raw.githubusercontent.com/chromium/chromium/'
                   f'{LOCK["chromiumRevision"]}/{path}')
            with urllib.request.urlopen(url, timeout=90) as response:
                target.write_bytes(response.read())
            if digest(target) != expected:
                raise RuntimeError(f'Upstream hash mismatch: {path}')
        for patch in patches():
            run('git', 'apply', '--check', patch, cwd=root)
            run('git', 'apply', patch, cwd=root)
        print('PASS: exact upstream hashes and patch application (not compilation)')


def checkout(url, revision, target):
    if not (target / '.git').exists():
        if target.exists() and any(target.iterdir()):
            raise RuntimeError(f'Refusing to adopt nonempty directory: {target}')
        target.mkdir(parents=True, exist_ok=True)
        run('git', 'init', '-q', target)
        run('git', 'remote', 'add', 'origin', url, cwd=target)
    if run('git', 'status', '--porcelain', '--untracked-files=no', cwd=target,
           capture=True).strip():
        raise RuntimeError(f'Existing source changes in {target}; use a new workspace')
    run('git', 'config', 'core.autocrlf', 'false', cwd=target)
    run('git', 'fetch', '--depth=1', 'origin', revision, cwd=target)
    run('git', 'checkout', '--detach', revision, cwd=target)

def target_platform():
    system, machine = platform.system(), platform.machine().lower()
    if system == 'Windows' and machine in ('amd64', 'x86_64'):
        return 'win-x64'
    if system == 'Linux' and machine == 'x86_64':
        return 'linux-x64'
    raise RuntimeError('Full builds require Windows x64 or Linux x86_64')


def executable_name(target):
    return 'chrome.exe' if target == 'win-x64' else 'chrome'


def prepared_lock(target):
    # Preserve existing Linux workspace markers, but never reuse a Windows sync
    # with Linux hooks (or vice versa).
    return {**LOCK, 'target': target} if target == 'win-x64' else LOCK


def validate_workspace(workspace):
    if platform.system() == 'Windows' and (' ' in str(workspace) or
                                           not workspace.drive):
        raise RuntimeError('Windows Chromium workspace must have a short absolute path without spaces')


def build_tool(name):
    if platform.system() == 'Windows':
        return name + '.bat'
    return name


def environment(workspace):
    target_platform()
    validate_workspace(workspace)
    depot_tools = str(workspace / 'depot_tools')
    if os.environ.get('PATH', '').split(os.pathsep)[0] != depot_tools:
        os.environ['PATH'] = depot_tools + os.pathsep + os.environ.get('PATH', '')
    os.environ['DEPOT_TOOLS_UPDATE'] = '0'
    os.environ['DEPOT_TOOLS_METRICS'] = '0'
    if platform.system() == 'Windows':
        os.environ['DEPOT_TOOLS_WIN_TOOLCHAIN'] = '0'


def bootstrap_depot_tools(workspace):
    if target_platform() != 'win-x64':
        return
    tools = workspace / 'depot_tools'
    if run('git', 'rev-parse', 'HEAD', cwd=tools, capture=True).strip() != LOCK['depotToolsRevision']:
        raise RuntimeError('depot_tools revision mismatch')
    marker = tools / 'python3_bin_reldir.txt'
    if not marker.is_file():
        # gclient.bat deliberately skips update_depot_tools.bat when auto-update
        # is disabled. Run only the pinned bootstrap: CIPD installs its pinned
        # Python and writes the shim marker without checking out origin/main.
        run(tools / 'bootstrap' / 'win_tools.bat', cwd=tools)
    if not marker.is_file():
        raise RuntimeError('depot_tools Windows Python bootstrap did not finish')
    relative = Path(marker.read_text(encoding='utf-8').strip())
    if (not relative.parts or relative.anchor or '..' in relative.parts or
            not (tools / relative / 'python3.exe').is_file()):
        raise RuntimeError('depot_tools Windows Python bootstrap is incomplete')


def verify_source(source):
    if run('git', 'rev-parse', 'HEAD', cwd=source, capture=True).strip() != LOCK['chromiumRevision']:
        raise RuntimeError('Chromium revision mismatch')
    # Compare the complete tracked diff to the locked patches on a pristine
    # index. This rejects additional edits even inside an already-patched file.
    with tempfile.TemporaryDirectory(prefix='abs-index-') as temp:
        index = Path(temp) / 'index'
        env = {**os.environ, 'GIT_INDEX_FILE': str(index)}
        subprocess.run(['git', 'read-tree', 'HEAD'], cwd=source, env=env, check=True)
        for patch in patches():
            subprocess.run(['git', 'apply', '--cached', str(patch)], cwd=source,
                           env=env, check=True)
        subprocess.run(['git', 'diff', '--exit-code'], cwd=source, env=env,
                       stdout=subprocess.DEVNULL, check=True)


def prepare(workspace):
    target = target_platform()
    validate_workspace(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    environment(workspace)
    source = workspace / 'src'
    marker = workspace / 'prepared.json'
    if marker.exists():
        if json.loads(marker.read_text()) != prepared_lock(target):
            raise RuntimeError('Lock or target changed; choose a fresh workspace')
        bootstrap_depot_tools(workspace)
        verify_source(source)
        print('Reusing verified source and incremental build directory')
        return
    if shutil.disk_usage(workspace).free < 150 * 1024**3:
        raise RuntimeError('Need at least 150 GiB free before initial source sync')
    patches()
    checkout('https://chromium.googlesource.com/chromium/tools/depot_tools.git',
             LOCK['depotToolsRevision'], workspace / 'depot_tools')
    bootstrap_depot_tools(workspace)
    checkout('https://chromium.googlesource.com/chromium/src.git',
             LOCK['chromiumRevision'], source)
    config = ('solutions = [{"name": "src", "url": '
              '"https://chromium.googlesource.com/chromium/src.git", '
              '"managed": False, "custom_deps": {}, "custom_vars": {}}]\n'
              f'target_os = ["{"win" if target == "win-x64" else "linux"}"]\n')
    (workspace / '.gclient').write_text(config, encoding='utf-8')
    run(build_tool('gclient'), 'sync', '--no-history', '--nohooks', '--revision',
        'src@' + LOCK['chromiumRevision'], cwd=workspace)
    for path, expected in LOCK['upstreamFiles'].items():
        if digest(source / path) != expected:
            raise RuntimeError(f'Upstream hash mismatch: {path}')
    for patch in patches():
        run('git', 'apply', '--check', patch, cwd=source)
        run('git', 'apply', patch, cwd=source)
    verify_source(source)
    marker.write_text(json.dumps(prepared_lock(target), indent=2) + '\n', encoding='utf-8')


def build(workspace, jobs):
    target = target_platform()
    environment(workspace)
    source = workspace / 'src'
    bootstrap_depot_tools(workspace)
    verify_source(source)
    run(build_tool('gclient'), 'runhooks', cwd=workspace)
    output = source / 'out' / 'Abs'
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / 'args.gn', output / 'args.gn')
    run(build_tool('gn'), 'gen', 'out/Abs', '--fail-on-unused-args', cwd=source)
    targets = ['chrome', 'blink_platform_unittests']
    if target == 'linux-x64':
        targets.insert(1, 'chrome_sandbox')
    run(build_tool('autoninja'), '-C', 'out/Abs', '-j', jobs, *targets, cwd=source)
    run(output / ('blink_platform_unittests.exe' if target == 'win-x64'
                  else 'blink_platform_unittests'), '--gtest_filter=AbsProfileTest.*',
        '--test-launcher-jobs=1', cwd=source)


def package(workspace, destination):
    target = target_platform()
    environment(workspace)
    source = workspace / 'src'
    bootstrap_depot_tools(workspace)
    verify_source(source)
    output = source / 'out' / 'Abs'
    if (output / 'args.gn').read_bytes() != (HERE / 'args.gn').read_bytes():
        raise RuntimeError('Build arguments differ from the checked-in configuration')
    dependencies = run(build_tool('gn'), 'desc', 'out/Abs', '//chrome:chrome', 'runtime_deps',
                       cwd=source, capture=True).splitlines()
    destination.mkdir(parents=True, exist_ok=True)
    stem = f'abs-chromium-{LOCK["browserVersion"]}-{target}'
    archive = destination / (stem + ('.zip' if target == 'win-x64' else '.tar.gz'))
    with tempfile.TemporaryDirectory(prefix='abs-package-') as temp:
        bundle = Path(temp) / 'chromium'
        bundle.mkdir()
        required = ['chrome_sandbox'] if target == 'linux-x64' else []
        for dependency in dependencies + required:
            relative = Path(dependency.strip())
            if not relative.parts:
                continue
            if relative.anchor or '..' in relative.parts:
                raise RuntimeError(f'Runtime dependency outside output: {dependency}')
            origin = output / relative
            bundled_name = 'chrome-sandbox' if str(relative) == 'chrome_sandbox' else relative
            target_path = bundle / bundled_name
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if origin.is_dir():
                shutil.copytree(origin, target_path, dirs_exist_ok=True)
            else:
                shutil.copy2(origin, target_path)
        executable = bundle / executable_name(target)
        if not executable.is_file():
            raise RuntimeError(f'Runtime dependency list did not contain {executable.name}')
        if target == 'win-x64' and not (bundle / 'chrome.dll').is_file():
            raise RuntimeError('Runtime dependency list did not contain chrome.dll')
        shutil.copy2(source / 'LICENSE', bundle / 'CHROMIUM-LICENSE')
        shutil.copy2(HERE / 'CHROMIX-LICENSE', bundle / 'CHROMIX-LICENSE')
        # Generated credits contain Chromium's third-party notices.
        credits = output / 'gen' / 'components' / 'resources' / 'about_credits.html'
        shutil.copy2(credits, bundle / 'about_credits.html')
        provenance = {**LOCK, 'target': target, 'argsSha256': digest(HERE / 'args.gn'),
                      'executableSha256': digest(executable),
                      'files': {p.relative_to(bundle).as_posix(): digest(p)
                                for p in sorted(bundle.rglob('*')) if p.is_file()}}
        (bundle / 'build-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
        if target == 'win-x64':
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED,
                                 compresslevel=6) as zf:
                for file in sorted(bundle.rglob('*')):
                    if file.is_file():
                        zf.write(file, 'chromium/' + file.relative_to(bundle).as_posix())
        else:
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(bundle, arcname='chromium')
    archive.with_suffix(archive.suffix + '.sha256').write_text(f'{digest(archive)}  {archive.name}\n')
    print(archive)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'prepare', 'build', 'package'])
    parser.add_argument('--workspace', type=Path, default=HERE / '.checkout')
    parser.add_argument('--output', type=Path, default=HERE / '.checkout' / 'artifacts')
    parser.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 2) // 2))
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    workspace = args.workspace.resolve()
    if args.command == 'check':
        check_subset()
    elif args.command == 'prepare':
        prepare(workspace)
    elif args.command == 'build':
        build(workspace, args.jobs)
    else:
        package(workspace, args.output.resolve())

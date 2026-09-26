import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('core', Path(__file__).with_name('core.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


class SourceVerificationTests(unittest.TestCase):
    def test_patch_hashes(self):
        self.assertEqual(len(core.patches()), 2)

    def test_rejects_modified_patch(self):
        with patch.object(core, 'LOCK', {**core.LOCK, 'patches': [
            {**core.LOCK['patches'][0], 'sha256': '0' * 64}
        ]}):
            with self.assertRaisesRegex(RuntimeError, 'Patch hash mismatch'):
                core.patches()

    def test_complete_diff_verification_rejects_extra_edits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            core.run('git', 'init', '-q', root)
            core.run('git', 'config', 'core.autocrlf', 'false', cwd=root)
            file = root / 'source.txt'
            file.write_text('before\n')
            core.run('git', 'add', '.', cwd=root)
            core.run('git', '-c', 'user.name=test', '-c', 'user.email=test@localhost',
                     'commit', '-qm', 'fixture', cwd=root)
            revision = core.run('git', 'rev-parse', 'HEAD', cwd=root, capture=True).strip()
            file.write_text('after\n')
            diff = subprocess.check_output(['git', 'diff', '--binary'], cwd=root)
            patch_file = root / 'fixture.patch'
            patch_file.write_bytes(diff)
            with patch.object(core, 'LOCK', {'chromiumRevision': revision}), \
                    patch.object(core, 'patches', return_value=[patch_file]):
                core.verify_source(root)
                file.write_text('after\nunrelated edit\n')
                with self.assertRaises(subprocess.CalledProcessError):
                    core.verify_source(root)

    def test_lock_matches_managed_browser(self):
        root = Path(__file__).resolve().parents[2]
        package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
        self.assertEqual(core.LOCK['playwrightVersion'], package['dependencies']['playwright'])

    def test_package_keeps_runtime_resources_credits_and_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'src'
            output = source / 'out' / 'Abs'
            files = {'chrome': 'fixture browser', 'chrome_sandbox': 'fixture sandbox',
                     'locales/fr.pak': 'fixture locale',
                     'gen/components/resources/about_credits.html': 'fixture credits'}
            for name, text in files.items():
                path = output / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            (source / 'LICENSE').write_text('fixture upstream license')
            (output / 'args.gn').write_bytes((core.HERE / 'args.gn').read_bytes())
            destination = root / 'artifacts'
            with patch.object(core, 'target_platform', return_value='linux-x64'), \
                    patch.object(core, 'environment'), patch.object(core, 'verify_source'), \
                    patch.object(core, 'run', return_value='chrome\nlocales/\n'):
                core.package(root, destination)
            archive = next(destination.glob('*.tar.gz'))
            with tarfile.open(archive) as tar:
                self.assertIn('chromium/locales/fr.pak', tar.getnames())
                self.assertIn('chromium/chrome-sandbox', tar.getnames())
                self.assertIn('chromium/about_credits.html', tar.getnames())
                provenance = json.load(tar.extractfile('chromium/build-provenance.json'))
                self.assertEqual(provenance['executableSha256'], core.digest(output / 'chrome'))
                self.assertEqual(provenance['files']['locales/fr.pak'], core.digest(output / 'locales/fr.pak'))
            self.assertTrue(archive.with_suffix('.gz.sha256').read_text().startswith(core.digest(archive)))

    def test_windows_package_contains_executable_runtime_resources_and_provenance(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'src'
            output = source / 'out' / 'Abs'
            files = {'chrome.exe': 'fixture executable', 'chrome.dll': 'fixture library',
                     'icudtl.dat': 'fixture icu', 'resources.pak': 'fixture resources',
                     'locales/fr.pak': 'fixture locale',
                     'gen/components/resources/about_credits.html': 'fixture credits'}
            for name, text in files.items():
                path = output / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            (source / 'LICENSE').write_text('fixture upstream license')
            (output / 'args.gn').write_bytes((core.HERE / 'args.gn').read_bytes())
            with patch.object(core, 'target_platform', return_value='win-x64'), \
                    patch.object(core, 'environment'), patch.object(core, 'bootstrap_depot_tools'), \
                    patch.object(core, 'verify_source'), \
                    patch.object(core, 'run', return_value='chrome.exe\nchrome.dll\nicudtl.dat\n'
                                                         'resources.pak\nlocales/\n'):
                core.package(root, root / 'artifacts')
            archive = root / 'artifacts' / f'abs-chromium-{core.LOCK["browserVersion"]}-win-x64.zip'
            with zipfile.ZipFile(archive) as zip_file:
                names = zip_file.namelist()
                for name in ('chrome.exe', 'chrome.dll', 'icudtl.dat', 'resources.pak',
                             'locales/fr.pak', 'CHROMIUM-LICENSE', 'CHROMIX-LICENSE',
                             'about_credits.html', 'build-provenance.json'):
                    self.assertIn(f'chromium/{name}', names)
                provenance = json.loads(zip_file.read('chromium/build-provenance.json'))
                self.assertEqual(provenance['target'], 'win-x64')
                self.assertEqual(provenance['chromiumRevision'], core.LOCK['chromiumRevision'])
                self.assertEqual(provenance['patches'], core.LOCK['patches'])
                self.assertEqual(provenance['executableSha256'], core.digest(output / 'chrome.exe'))
                self.assertEqual(provenance['files']['chrome.dll'], core.digest(output / 'chrome.dll'))
            self.assertTrue(archive.with_suffix('.zip.sha256').read_text().startswith(core.digest(archive)))

    def test_windows_package_rejects_missing_native_library(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'src' / 'out' / 'Abs'
            output.mkdir(parents=True)
            (output / 'args.gn').write_bytes((core.HERE / 'args.gn').read_bytes())
            (output / 'chrome.exe').write_bytes(b'fixture executable')
            with patch.object(core, 'target_platform', return_value='win-x64'), \
                    patch.object(core, 'environment'), patch.object(core, 'bootstrap_depot_tools'), \
                    patch.object(core, 'verify_source'), \
                    patch.object(core, 'run', return_value='chrome.exe\n'):
                with self.assertRaisesRegex(RuntimeError, 'chrome.dll'):
                    core.package(root, root / 'artifacts')

    def test_windows_prepare_pins_dependencies_and_marks_target(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def checkout_fixture(_url, _revision, destination):
                destination.mkdir(parents=True)
                if destination.name == 'depot_tools':
                    (destination / 'bootstrap').mkdir()
                    (destination / 'bootstrap' / 'win_tools.bat').write_text('pinned bootstrap')
            def upstream_digest(path):
                return core.LOCK['upstreamFiles'][path.relative_to(root / 'src').as_posix()]
            def run_fixture(*args, **kwargs):
                if args[:3] == ('git', 'rev-parse', 'HEAD'):
                    return core.LOCK['depotToolsRevision'] + '\n'
                if str(args[0]).endswith('win_tools.bat'):
                    tools = root / 'depot_tools'
                    python = tools / 'bootstrap-python' / 'python3.exe'
                    python.parent.mkdir()
                    python.write_bytes(b'fixture python')
                    (tools / 'python3_bin_reldir.txt').write_text('bootstrap-python\n')
                return ''
            with patch.object(core, 'target_platform', return_value='win-x64'), \
                    patch.object(core, 'validate_workspace'), patch.object(core, 'environment'), \
                    patch.object(core, 'checkout', side_effect=checkout_fixture), \
                    patch.object(core, 'patches', return_value=[]), \
                    patch.object(core, 'digest', side_effect=upstream_digest), \
                    patch.object(core, 'verify_source'), \
                    patch.object(core, 'run', side_effect=run_fixture), \
                    patch.object(core.shutil, 'disk_usage', return_value=SimpleNamespace(free=151 * 1024**3)):
                core.prepare(root)
            self.assertIn('target_os = [\"win\"]', (root / '.gclient').read_text())
            self.assertEqual(json.loads((root / 'prepared.json').read_text())['target'], 'win-x64')
            self.assertEqual(json.loads((root / 'prepared.json').read_text())['chromiumRevision'],
                             core.LOCK['chromiumRevision'])
            self.assertTrue((root / 'depot_tools' / 'bootstrap-python' / 'python3.exe').is_file())

    def test_windows_bootstrap_rejects_wrong_tools_revision_or_missing_python(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tools = root / 'depot_tools'
            tools.mkdir()
            with patch.object(core, 'target_platform', return_value='win-x64'), \
                    patch.object(core, 'run', return_value='wrong revision'):
                with self.assertRaisesRegex(RuntimeError, 'depot_tools revision mismatch'):
                    core.bootstrap_depot_tools(root)
            with patch.object(core, 'target_platform', return_value='win-x64'), \
                    patch.object(core, 'run', return_value=core.LOCK['depotToolsRevision']):
                with self.assertRaisesRegex(RuntimeError, 'Python bootstrap did not finish'):
                    core.bootstrap_depot_tools(root)

    def test_package_rejects_runtime_path_outside_build_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'src' / 'out' / 'Abs'
            output.mkdir(parents=True)
            (output / 'args.gn').write_bytes((core.HERE / 'args.gn').read_bytes())
            with patch.object(core, 'target_platform', return_value='linux-x64'), \
                    patch.object(core, 'environment'), patch.object(core, 'verify_source'), \
                    patch.object(core, 'run', return_value='../../outside.txt\n'):
                with self.assertRaisesRegex(RuntimeError, 'outside output'):
                    core.package(root, root / 'artifacts')


if __name__ == '__main__':
    unittest.main()

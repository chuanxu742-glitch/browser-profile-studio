import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('core', Path(__file__).with_name('core.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


class SourceVerificationTests(unittest.TestCase):
    def test_patch_hashes(self):
        self.assertEqual(len(core.patches()), 1)

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
            with patch.object(core, 'environment'), patch.object(core, 'verify_source'), \
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

    def test_package_rejects_runtime_path_outside_build_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'src' / 'out' / 'Abs'
            output.mkdir(parents=True)
            (output / 'args.gn').write_bytes((core.HERE / 'args.gn').read_bytes())
            with patch.object(core, 'environment'), patch.object(core, 'verify_source'), \
                    patch.object(core, 'run', return_value='../../outside.txt\n'):
                with self.assertRaisesRegex(RuntimeError, 'outside output'):
                    core.package(root, root / 'artifacts')


if __name__ == '__main__':
    unittest.main()

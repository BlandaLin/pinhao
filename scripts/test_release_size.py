import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZIP_DEFLATED, ZipFile

spec = importlib.util.spec_from_file_location("release_size", Path(__file__).with_name("release-size.py"))
release_size = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_size)


class ReleaseSizeTests(unittest.TestCase):
    def fixture(self, root):
        directory = root / "app"
        files = {"PinhaoWorkbench.exe": b"electron", "resources/app/main.mjs": b"export const x=1;",
                 "resources/app/resources/fonts/font.ttf": b"font", "SOURCE-CODE.zip": b"source"}
        for name, data in files.items():
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return directory, files

    def test_component_totals_and_zip_structure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory, files = self.fixture(root)
            archive = root / "app.zip"
            with ZipFile(archive, "w", ZIP_DEFLATED) as zipped:
                for file in files:
                    zipped.write(directory / file, "app/" + file)
            report = release_size.measure_release(directory, archive=archive)
            self.assertEqual(report["files"], 4)
            self.assertEqual(report["logicalBytes"], sum(map(len, files.values())))
            self.assertEqual(sum(c["logicalBytes"] for c in report["components"]), report["logicalBytes"])
            self.assertEqual(report["archive"]["bytes"], report["archive"]["compressedPayloadBytes"] + report["archive"]["structureBytes"])
            self.assertIsNone(report["firstLaunchAddedBytes"])
            self.assertTrue(report["origin"]["payloadHashesRecomputed"])

    def test_manifest_reuse_checks_lengths_without_rehashing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory, files = self.fixture(root)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"version": "fixture", "manifest": [
                {"path": file, "bytes": len(data), "sha256": "historical-fixture-hash"} for file, data in files.items()
            ]}), encoding="utf-8")
            report = release_size.measure_release(directory, manifest=manifest)
            self.assertFalse(report["origin"]["payloadHashesRecomputed"])
            self.assertEqual(report["origin"]["version"], "fixture")
            extra = directory / "unexpected.txt"
            extra.write_bytes(b"not in manifest")
            with self.assertRaisesRegex(ValueError, "manifest file sets differ"):
                release_size.measure_release(directory, manifest=manifest)
            extra.unlink()
            (directory / "PinhaoWorkbench.exe").write_bytes(b"changed length")
            with self.assertRaisesRegex(ValueError, "length differs"):
                release_size.measure_release(directory, manifest=manifest)

    def test_zip_must_match_exact_release_set(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory, _ = self.fixture(root)
            archive = root / "app.zip"
            with ZipFile(archive, "w") as zipped:
                zipped.writestr("app/extra.txt", "not in release")
            with self.assertRaisesRegex(ValueError, "file sets differ"):
                release_size.measure_release(directory, archive=archive)

    def test_nearest_package_owner_and_duplicate_candidates(self):
        packages = [{"path": "node_modules/outer/node_modules/inner", "workspace": False},
                    {"path": "node_modules/outer", "workspace": True}]
        self.assertEqual(release_size.component(release_size.DSH + "node_modules/outer/lib.js", packages), "dsh-workspace")
        self.assertEqual(release_size.component(release_size.DSH + "node_modules/outer/node_modules/inner/lib.js", packages), "dsh-third-party")
        with tempfile.TemporaryDirectory() as temporary:
            directory, _ = self.fixture(Path(temporary))
            (directory / "duplicate.txt").write_bytes(b"electron")
            report = release_size.measure_release(directory)
            self.assertEqual(len(report["duplicateCandidates"]), 1)
            self.assertEqual(report["duplicateCandidates"][0]["redundantLogicalBytes"], 8)
            self.assertTrue(report["duplicateCandidatesAreNotDeletionApproval"])

    def test_unsafe_relative_paths_are_rejected(self):
        for file in ["../file", "C:/file", "a\\b", "/file", "a//b"]:
            with self.assertRaises(ValueError):
                release_size.relative_file(file)


if __name__ == "__main__":
    unittest.main()

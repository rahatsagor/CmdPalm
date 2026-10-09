"""Release gates must reject inconsistent versions and unusable update keys."""

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
KEY_TEST_ENV = {"PATH": os.environ.get("PATH", os.defpath)}
spec = importlib.util.spec_from_file_location("release_notes", SCRIPTS / "release_notes.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseVersionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "web").mkdir()
        (self.root / "apple").mkdir()
        (self.root / "Cargo.toml").write_text('[workspace.package]\nversion = "0.1.0"\n')
        (self.root / "web/package.json").write_text(json.dumps({"version": "0.1.0"}))
        (self.root / "apple/project.yml").write_text('    MARKETING_VERSION: "0.1.0"\n')
        (self.root / "CHANGELOG.md").write_text("## [0.1.0] - 2026-10-09\n\n- First release.\n")
        root_patch = patch.object(release, "ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def test_consistent_metadata_passes(self):
        release.check_version("0.1.0")

    def test_each_manifest_must_match_the_tag(self):
        files = ["Cargo.toml", "web/package.json", "apple/project.yml"]
        for filename in files:
            with self.subTest(filename=filename):
                path = self.root / filename
                original = path.read_text()
                path.write_text(original.replace("0.1.0", "0.2.0"))
                with self.assertRaisesRegex(SystemExit, filename.replace(".", r"\.")):
                    release.check_version("0.1.0")
                path.write_text(original)

    def test_missing_or_empty_release_notes_are_rejected(self):
        for changelog in ["## [Unreleased]\n", "## [0.1.0]\n\n"]:
            with self.subTest(changelog=changelog):
                (self.root / "CHANGELOG.md").write_text(changelog)
                with self.assertRaises(SystemExit):
                    release.check_version("0.1.0")

    def test_build_numbers_increase_at_version_boundaries(self):
        self.assertLess(release.build_number("0.1.99"), release.build_number("0.2.0"))
        self.assertLess(release.build_number("0.99.99"), release.build_number("1.0.0"))

    def test_ambiguous_and_out_of_range_versions_are_rejected(self):
        for version in ["01.2.3", "0.08.0", "1.100.0", "1.2.100", "1.2.3-beta", "1.2"]:
            with self.subTest(version=version):
                with self.assertRaises(SystemExit):
                    release.build_number(version)
                for script in ["build-app.sh", "bump-version.sh"]:
                    command = [str(SCRIPTS / script), version]
                    if script == "build-app.sh":
                        command.insert(1, "--version")
                    result = subprocess.run(command, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2, result.stderr)


class SparkleKeyTests(unittest.TestCase):
    def keys(self, legacy=False):
        # RFC 8032 section 7.1, test 1 (public test vector, not a release key).
        seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        public = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        private = seed
        if legacy:
            expanded = bytearray(hashlib.sha512(seed).digest())
            expanded[0] &= 248
            expanded[31] = (expanded[31] & 63) | 64
            private = bytes(expanded) + public
        return {
            "SPARKLE_PUBLIC_KEY": base64.b64encode(public).decode(),
            "SPARKLE_PRIVATE_KEY": base64.b64encode(private).decode(),
        }

    def test_current_and_legacy_exports_are_accepted(self):
        for legacy in [False, True]:
            with self.subTest(legacy=legacy), patch.dict(os.environ, KEY_TEST_ENV | self.keys(legacy), clear=True):
                release.check_keys()

    def test_mismatched_keys_are_rejected_without_printing_the_secret(self):
        keys = self.keys()
        keys["SPARKLE_PUBLIC_KEY"] = base64.b64encode(bytes(32)).decode()
        with patch.dict(os.environ, KEY_TEST_ENV | keys, clear=True):
            with self.assertRaisesRegex(SystemExit, "do not match") as error:
                release.check_keys()
        self.assertNotIn(keys["SPARKLE_PRIVATE_KEY"], str(error.exception))

    def test_missing_malformed_and_wrong_length_keys_are_rejected(self):
        invalid = [{}, {"SPARKLE_PUBLIC_KEY": "not base64!", "SPARKLE_PRIVATE_KEY": "bad"}]
        keys = self.keys()
        keys["SPARKLE_PRIVATE_KEY"] = base64.b64encode(bytes(64)).decode()
        invalid.append(keys)
        keys = self.keys()
        keys["SPARKLE_PUBLIC_KEY"] += "\n"
        invalid.append(keys)
        for keys in invalid:
            with self.subTest(keys=list(keys)), patch.dict(os.environ, KEY_TEST_ENV | keys, clear=True):
                with self.assertRaises(SystemExit):
                    release.check_keys()

    def test_archive_signature_is_verified_before_use(self):
        signature = base64.b64encode(bytes(64)).decode()
        signed = subprocess.CompletedProcess([], 0, signature + "\n", "")
        verified = subprocess.CompletedProcess([], 0, "", "")
        env = {"SPARKLE_SIGN_UPDATE": "/sparkle/sign_update", **self.keys()}
        with patch.dict(os.environ, env, clear=True), patch.object(
            release.subprocess, "run", side_effect=[signed, verified]
        ) as run:
            self.assertEqual(release.sign(Path("CmdPalm.zip")), signature)
            verify = run.call_args_list[1]
            self.assertEqual(
                verify.args[0],
                ["/sparkle/sign_update", "--ed-key-file", "-", "--verify", "CmdPalm.zip", signature],
            )
            self.assertEqual(verify.kwargs["input"], env["SPARKLE_PRIVATE_KEY"])

    def test_failed_archive_verification_stops_the_release(self):
        signed = subprocess.CompletedProcess([], 0, "signature", "")
        rejected = subprocess.CompletedProcess([], 1, "", "invalid signature")
        with patch.dict(os.environ, {"SPARKLE_SIGN_UPDATE": "/sparkle/sign_update"}), patch.object(
            release.subprocess, "run", side_effect=[signed, rejected]
        ):
            with self.assertRaisesRegex(SystemExit, "archive signature verification failed"):
                release.sign(Path("CmdPalm.zip"))


if __name__ == "__main__":
    unittest.main()

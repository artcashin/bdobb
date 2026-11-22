#!/usr/bin/env python3
"""Run unchanged auditor controls with explicit native-Windows omissions."""
import argparse
import json
from pathlib import Path
import platform
import unittest

WINDOWS_OMISSIONS = {
    "test_gate.GateTests.test_unreadable_artifact_subtree_is_not_silently_skipped":
        "POSIX chmod(0) does not model Windows ACL denial; unchanged Linux/macOS coverage retained",
    "test_gate.GateTests.test_image_pipeline_never_pushes_an_unsafe_layer":
        "POSIX Bash/shebang/chmod fake Docker pipeline is not a native Windows image-publisher test",
    "test_gate.GateTests.test_later_gif_frame_ocr_failure_remains_blocked":
        "Extensionless shebang OCR failure fake is not a native Windows executable",
    "test_gate.GateTests.test_real_tutorial_dimensions_fit_decoded_frame_budget":
        "Extensionless shebang OCR fake is not a native Windows executable",
    "test_gate.GateTests.test_unused_legacy_background_requires_one_full_transparent_frame":
        "Extensionless shebang OCR fake is not a native Windows executable",
    "test_gate.GateTests.test_gif_pixel_cache_preserves_each_exact_exception_path":
        "Extensionless shebang OCR counter/output fake cannot prove intended semantics on native Windows",
    "test_public_release.PublicReleaseTests.test_release_clears_all_operator_defaults_before_the_native_build":
        "POSIX release.sh uses Bash/shebang executable fakes; all six actual Windows build defaults remain checked",
    "test_public_release.PublicReleaseTests.test_appimage_links_preserve_target_metadata_without_following_aliases":
        "Linux AppImage link metadata uses POSIX path/symlink semantics; native Linux/macOS coverage retained",
    "test_public_release.PublicReleaseTests.test_appimage_links_reject_escape_absolute_dangling_and_cycles":
        "Linux AppImage link traversal uses POSIX path/symlink semantics; native Linux/macOS coverage retained",
    "test_public_release.PublicReleaseTests.test_appimage_link_raw_target_still_reaches_shared_privacy_gate":
        "Linux AppImage symlink creation is not a Windows package path; native Linux/macOS coverage retained",
    "test_public_release.PublicReleaseTests.test_appimage_package_with_internal_alias_passes_real_shared_gate":
        "Linux AppImage symlink fixture is not a Windows package path; native Linux/macOS coverage retained",
}


class PlatformOmission(unittest.TestCase):
    def __init__(self, original_id, reason):
        super().__init__("runTest")
        self.original_id = original_id
        self.reason = reason

    def id(self):
        return self.original_id

    def runTest(self):
        self.skipTest(self.reason)


def cases(suite):
    for value in suite:
        if isinstance(value, unittest.TestSuite):
            yield from cases(value)
        else:
            yield value


def scoped_suite(suite, system):
    original = list(cases(suite))
    omitted = WINDOWS_OMISSIONS if system == "Windows" else {}
    if omitted and not set(omitted).issubset({case.id() for case in original}):
        raise ValueError("Reviewed Windows omission list no longer matches exact auditor tests")
    return unittest.TestSuite(
        PlatformOmission(case.id(), omitted[case.id()]) if case.id() in omitted else case
        for case in original
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auditor", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    suite = unittest.TestSuite()
    for directory, pattern in [("security", "test_gate.py"), ("scripts", "test_public_release.py")]:
        root = args.auditor.resolve() / directory
        suite.addTests(unittest.TestLoader().discover(str(root), pattern=pattern, top_level_dir=str(root)))
    suite = scoped_suite(suite, platform.system())
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    args.evidence.mkdir(parents=True, exist_ok=True)
    receipt = {
        "platform": platform.system(), "tests_run": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors),
        "skipped": [{"test": case.id(), "reason": reason} for case, reason in result.skipped],
        "status": "PASS_WITH_EXPLICIT_PLATFORM_OMISSIONS" if result.wasSuccessful() and result.skipped else "PASS" if result.wasSuccessful() else "FAIL",
        "scope": "test harness only; actual source/history/installed-byte/default/offer gates are unchanged and mandatory",
    }
    (args.evidence / "auditor-controls.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()

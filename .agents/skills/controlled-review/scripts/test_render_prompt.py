import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from render_prompt import ANGLES, COMMON, render


class PromptTests(unittest.TestCase):
    def test_context_is_verbatim_in_every_role(self):
        context = "目的: UTF-8を保つ\n## Dispositions\n- non-actionable: C1\n\n## 補足\n{angle} $HOME `literal`\n"
        for angle in ANGLES:
            prompt = render(context, "finder", angle=angle)
            self.assertTrue(prompt.startswith(COMMON + context + "\n\n"))
            self.assertEqual(prompt.count(context), 1)
        candidate = "C2: {candidate}\n## quote\n`do not expand`\n"
        verifier = render(context, "verifier", candidate=candidate)
        self.assertTrue(verifier.startswith(COMMON + context + "\n\n"))
        self.assertEqual(verifier.count(context), 1)
        self.assertTrue(verifier.endswith(candidate))
        self.assertEqual(verifier.count(candidate), 1)

    def test_missing_or_conflicting_role_input_fails(self):
        self.assertEqual(set(ANGLES), {"line-scan", "removed-behavior", "cross-file", "reuse",
                                      "simplification", "efficiency", "altitude", "conventions"})
        for kwargs in [dict(role="finder"), dict(role="finder", angle="unknown"),
                       dict(role="finder", angle=[]), dict(role="finder", angle=["reuse", "reuse"]),
                       dict(role="finder", angle="reuse", candidate="C1"),
                       dict(role="verifier"), dict(role="verifier", candidate=" "),
                       dict(role="verifier", angle="reuse", candidate="C1")]:
            with self.assertRaises(ValueError):
                render("conditions", **kwargs)
        with self.assertRaises(ValueError):
            render(" ", "finder", angle="reuse")

    def test_cli_reads_files_and_emits_exact_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / "context.md"
            candidate = Path(directory) / "candidate.md"
            context.write_text("目的: 既存処分を守る\n## Dispositions\nC1: 非採用\n", encoding="utf-8")
            candidate.write_text("C2: 入力0で誤る\n", encoding="utf-8")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("render_prompt.py")),
                                     "--context", str(context), "--role", "verifier", "--candidate", str(candidate)],
                                    capture_output=True, check=True)
            self.assertEqual(result.stdout, render(context.read_text(encoding="utf-8"), "verifier",
                                                   candidate=candidate.read_text(encoding="utf-8")).encode())
            context.write_text("", encoding="utf-8")
            failure = subprocess.run([sys.executable, str(Path(__file__).with_name("render_prompt.py")),
                                      "--context", str(context), "--role", "finder", "--angle", "reuse"],
                                     capture_output=True)
            self.assertNotEqual(failure.returncode, 0)
            self.assertEqual(failure.stdout, b"")

    def test_cli_groups_explicit_angles_without_duplicating_context(self):
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / "context.md"
            context.write_text("条件: 同じ差分の観点を統合する\n", encoding="utf-8")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("render_prompt.py")),
                                     "--context", str(context), "--role", "finder",
                                     "--angle", "line-scan", "--angle", "cross-file"],
                                    capture_output=True, check=True)
            output = result.stdout.decode("utf-8")
            self.assertEqual(output.count(context.read_text(encoding="utf-8")), 1)
            self.assertIn(ANGLES["line-scan"], output)
            self.assertIn(ANGLES["cross-file"], output)
            self.assertNotIn(ANGLES["efficiency"], output)

    def test_cli_preserves_bom_and_crlf_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / "context.md"
            candidate = Path(directory) / "candidate.md"
            context_bytes = b"\xef\xbb\xbfcontext: fixed\r\nline: two\r\n"
            candidate_bytes = b"\xef\xbb\xbfC1: candidate\r\nevidence: fixed\r\n"
            context.write_bytes(context_bytes)
            candidate.write_bytes(candidate_bytes)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("render_prompt.py")),
                                     "--context", str(context), "--role", "verifier",
                                     "--candidate", str(candidate)], capture_output=True, check=True)
            self.assertEqual(result.stdout.count(context_bytes), 1)
            self.assertEqual(result.stdout.count(candidate_bytes), 1)
            self.assertTrue(result.stdout.endswith(candidate_bytes))


if __name__ == "__main__":
    unittest.main()

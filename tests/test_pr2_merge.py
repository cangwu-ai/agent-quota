"""Exercise merge preparation in disposable copies without committing or pushing."""
import io
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/prepare-pr2-merge.sh"
TARGET = "18fa0e3eb4c9527a144806684ea64c03812f4318"
SOURCE = "7958b3177b8a61c62e05d34953496109ffcb612c"


class MergePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="quota-pr2-merge-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "--initial-branch=card-01")
        # Fixed historical fixtures keep this regression valid after the real
        # branch gains its merge commit. All Git writes stay in the temp repo.
        shutil.copytree(ROOT / ".git/objects", self.repo / ".git/objects", dirs_exist_ok=True)
        self.git("update-ref", "refs/heads/card-01", SOURCE)
        self.git("update-ref", "refs/remotes/origin/main", TARGET)
        self.git("read-tree", SOURCE)
        self.git("config", "user.name", "Merge preparation test")
        self.git("config", "user.email", "merge-test@example.invalid")
        archive = subprocess.run(["git", "archive", SOURCE], cwd=ROOT,
                                 check=True, capture_output=True).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as files:
            files.extractall(self.repo, filter="data")
        self.head = self.git("rev-parse", "HEAD").stdout.strip()

    def git(self, *args, check=True):
        return subprocess.run(["git", *args], cwd=self.repo, text=True,
                              capture_output=True, check=check)

    def prepare(self):
        return subprocess.run(["bash", str(SCRIPT)], cwd=self.repo,
                              text=True, capture_output=True)

    def assert_no_merge(self):
        self.assertNotEqual(self.git("rev-parse", "--verify", "MERGE_HEAD", check=False).returncode, 0)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.head)

    def test_real_merge_retains_second_parent_and_all_reviewed_files(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "MERGE_HEAD").stdout.strip(), TARGET)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.head)
        self.assertEqual(self.git("branch", "--show-current").stdout.strip(), "card-01")
        self.assertEqual(self.git("ls-files", "--unmerged").stdout, "")
        # The reviewed HEAD already has all required content. Only merge history
        # was missing: preparing it must preserve the complete reviewed tree.
        self.assertEqual(self.git("write-tree").stdout,
                         self.git("rev-parse", "HEAD^{tree}").stdout)
        self.git("diff", "--check")
        self.git("diff", "--cached", "--check")

    def test_dirty_files_are_preserved_and_rejected_before_merging(self):
        readme = self.repo / "README.md"
        readme.write_text("local work\n")
        self.assertNotEqual(self.prepare().returncode, 0)
        self.assertEqual(readme.read_text(), "local work\n")
        self.assert_no_merge()

    def test_changed_main_is_rejected_before_merging(self):
        self.git("update-ref", "refs/remotes/origin/main", self.head)
        self.assertNotEqual(self.prepare().returncode, 0)
        self.assert_no_merge()

    def test_existing_merge_is_preserved_and_rejected(self):
        result = self.git("merge", "--no-ff", "--no-commit", TARGET, check=False)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(set(self.git("diff", "--name-only", "--diff-filter=U").stdout.splitlines()),
                         {".gitignore", "README.md", "frontend/dashboard-model.mjs",
                          "frontend/quota-data.mjs", "index.html"})
        conflicts = self.git("ls-files", "--unmerged").stdout
        self.assertTrue(conflicts)
        self.assertNotEqual(self.prepare().returncode, 0)
        self.assertEqual(self.git("ls-files", "--unmerged").stdout, conflicts)
        self.assertEqual(self.git("rev-parse", "MERGE_HEAD").stdout.strip(), TARGET)


if __name__ == "__main__":
    unittest.main()

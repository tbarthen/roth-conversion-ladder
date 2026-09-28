"""Minimal GitHub REST client (stdlib only)."""
import base64
import json
import urllib.error
import urllib.request

API = "https://api.github.com"


class GitHubError(Exception):
    def __init__(self, status, message):
        super().__init__(f"GitHub API {status}: {message}")
        self.status = status


class GitHub:
    def __init__(self, token, repo, timeout=15):
        if not token or not repo:
            raise ValueError("GITHUB_TOKEN and GITHUB_REPO are required")
        self.token, self.repo, self.timeout = token, repo, timeout

    def _call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{API}/repos/{self.repo}{path}", data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "roth-ladder-tax-fetcher",
            **({"Content-Type": "application/json"} if data else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("message", "")
            except Exception:
                msg = e.reason
            raise GitHubError(e.code, msg) from None

    def read_file(self, path, ref):
        data = self._call("GET", f"/contents/{path}?ref={ref}")
        if data.get("encoding") != "base64":
            raise GitHubError(0, f"unexpected encoding for {path}")
        return base64.b64decode(data["content"]).decode("utf-8")

    def branch_sha(self, branch):
        return self._call("GET", f"/git/ref/heads/{branch}")["object"]["sha"]

    def commit_files(self, base_branch, target_branch, files, message):
        """Create one commit on top of base_branch containing `files`
        ({path: text}) and point target_branch at it. Returns the commit URL."""
        base_sha = self.branch_sha(base_branch)
        base_tree = self._call("GET", f"/git/commits/{base_sha}")["tree"]["sha"]
        tree = self._call("POST", "/git/trees", {
            "base_tree": base_tree,
            "tree": [{"path": p, "mode": "100644", "type": "blob", "content": c} for p, c in files.items()],
        })
        commit = self._call("POST", "/git/commits", {"message": message, "tree": tree["sha"], "parents": [base_sha]})
        try:
            self._call("PATCH", f"/git/refs/heads/{target_branch}", {"sha": commit["sha"], "force": True})
        except GitHubError as e:
            if e.status not in (404, 422):
                raise
            self._call("POST", "/git/refs", {"ref": f"refs/heads/{target_branch}", "sha": commit["sha"]})
        return commit.get("html_url") or f"https://github.com/{self.repo}/commit/{commit['sha']}"

    def open_or_update_issue(self, label, title, body):
        """Comment on the open issue with `label`, or open a new one. Returns its URL."""
        issues = self._call("GET", f"/issues?state=open&labels={label}&per_page=5") or []
        issues = [i for i in issues if "pull_request" not in i]
        if issues:
            self._call("POST", f"/issues/{issues[0]['number']}/comments", {"body": body})
            return issues[0]["html_url"]
        issue = self._call("POST", "/issues", {"title": title, "body": body, "labels": [label]})
        return issue["html_url"]

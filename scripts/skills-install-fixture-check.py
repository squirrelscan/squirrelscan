"""Release gate for `squirrel skills install` (#1367): install from a local fixture server.

Usage: skills-install-fixture-check.py <home-dir> <squirrel command...>

Starts a loopback server that serves a one-skill fixture (`manifest.json` and `skills/<skill>/<file>`),
runs `<squirrel command> skills install` with SQUIRREL_SKILLS_TEST_SOURCE pointing at it, in a scratch
HOME, and checks that the files landed with the manifest's sha256. Every proxy variable points at a dead
port (loopback excepted), so a request to GitHub or any other host would fail the install. Standard
library only, so it runs on every release-gate runner.
"""

import hashlib
import http.server
import json
import os
import subprocess
import sys
import threading

SKILL = "squirrelscan"
FILES = {
    "SKILL.md": f"---\nname: {SKILL}\ndescription: install gate fixture\nmetadata:\n  author: squirrelscan\n  version: \"1.0\"\n---\nFixture skill.\n",
    "references/a.md": "fixture reference\n",
}


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


MANIFEST = {
    "schema": 1,
    "skills": [
        {
            "name": SKILL,
            "version": "1.0",
            "files": [{"path": p, "sha256": sha256(c), "size": len(c.encode())} for p, c in FILES.items()],
        }
    ],
}

hits: list[str] = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - the name http.server dispatches on
        hits.append(self.path)
        if self.path == "/manifest.json":
            body = json.dumps(MANIFEST).encode()
        elif self.path.startswith(f"/skills/{SKILL}/") and self.path[len(f"/skills/{SKILL}/") :] in FILES:
            body = FILES[self.path[len(f"/skills/{SKILL}/") :]].encode()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        pass


def fail(message: str, *details: str) -> None:
    print(f"::error::{message}")
    for d in details:
        print(d)
    sys.exit(1)


def main() -> None:
    home, command = sys.argv[1], sys.argv[2:]
    if not command:
        fail("usage: skills-install-fixture-check.py <home-dir> <squirrel command...>")
    os.makedirs(home, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    source = f"http://127.0.0.1:{server.server_address[1]}"
    dead_proxy = "http://127.0.0.1:9"
    env = dict(os.environ)
    env.update(
        HOME=home,
        USERPROFILE=home,
        LOCALAPPDATA=os.path.join(home, "AppData", "Local"),
        APPDATA=os.path.join(home, "AppData", "Roaming"),
        SQUIRREL_NO_UPDATE="1",
        NO_TELEMETRY="1",
        SQUIRREL_SKILLS_TEST_SOURCE=source,
        HTTP_PROXY=dead_proxy,
        HTTPS_PROXY=dead_proxy,
        http_proxy=dead_proxy,
        https_proxy=dead_proxy,
        NO_PROXY="127.0.0.1,localhost",
        no_proxy="127.0.0.1,localhost",
    )
    proc = subprocess.run([*command, "skills", "install"], env=env, capture_output=True, text=True, timeout=120)
    server.shutdown()
    output = f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}\n--- requests ---\n{hits}"
    if proc.returncode != 0:
        fail(f"squirrel skills install exited {proc.returncode}", output)
    if "/manifest.json" not in hits:
        fail("the fixture server never saw the manifest request", output)
    if f"reading agent skills from {source}" not in proc.stderr:
        fail("squirrel did not announce the test source on stderr", output)
    landed = os.path.join(home, ".agents", "skills", SKILL)
    for path, content in FILES.items():
        target = os.path.join(landed, *path.split("/"))
        if not os.path.isfile(target):
            fail(f"{target} was not installed", output)
        with open(target, encoding="utf-8", newline="") as handle:
            got = handle.read()
        if sha256(got) != sha256(content):
            fail(f"{target} does not match the manifest's sha256", output)
        if f"/skills/{SKILL}/{path}" not in hits:
            fail(f"the fixture server never saw a request for {path}", output)
    print(f"squirrel skills install read {len(FILES)} files from the local fixture ({len(hits)} requests)")


main()

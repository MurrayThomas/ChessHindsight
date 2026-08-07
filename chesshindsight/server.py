"""Local HTTP transport.

Serves the same frontend and the same Api object that the desktop window uses.
Bound to loopback only — this is a personal tool, not a service.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import socket
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger(__name__)

from .api import Api, PUBLIC_METHODS
from .paths import resource_dir

WEB_DIR = resource_dir() / "web"
MAX_BODY = 8 * 1024 * 1024

# On Windows `mimetypes` seeds itself from the registry, so a machine with an
# unusual file-association setup can serve piece artwork as octet-stream and
# leave the board blank. Declaring the handful of types we actually serve costs
# nothing and removes the dependency on the host's configuration.
for _ext, _type in {
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".png": "image/png",
    ".gif": "image/gif",
    ".js": "application/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".ico": "image/x-icon",
}.items():
    mimetypes.add_type(_type, _ext)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Without this an idle keep-alive connection parks a thread in readline()
    # forever. Chromium holds several connections open per origin, so over a
    # long session those threads — and their thread-local SQLite connections —
    # accumulate without bound.
    timeout = 65

    def __init__(self, *args, api: Api, **kwargs):
        self.api = api
        super().__init__(*args, **kwargs)

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(self.timeout)

    def handle_one_request(self) -> None:
        """Treat a read timeout as a closed connection rather than an error."""
        try:
            super().handle_one_request()
        except socket.timeout:
            self.close_connection = True
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            # The webview cancels in-flight fetches routinely (navigation,
            # re-render). That is normal, not a fault.
            self.close_connection = True

    def finish(self) -> None:
        try:
            super().finish()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
            pass

    # Quieter logs; the dev server prints one line per request otherwise.
    def log_message(self, fmt, *args):  # noqa: A002
        pass

    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        if not path.is_file():
            self._send_json({"error": "not found"}, 404)
            return
        data = path.read_bytes()
        ctype, _ = mimetypes.guess_type(str(path))
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", ""):
            self._send_file(WEB_DIR / "index.html")
            return
        # Resolve inside WEB_DIR only, so ../ can't escape the static root.
        target = (WEB_DIR / path.lstrip("/")).resolve()
        try:
            target.relative_to(WEB_DIR.resolve())
        except ValueError:
            self._send_json({"error": "forbidden"}, 403)
            return
        self._send_file(target)

    def do_POST(self) -> None:  # noqa: N802
        # Always consume the request body first. On a keep-alive connection an
        # unread body would be parsed as the *next* request line, corrupting
        # every subsequent request on that socket.
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raw = b""
            self.close_connection = True
            self._send_json({"error": "body too large"}, 413)
            return
        raw = self.rfile.read(length) if length else b"{}"

        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
            return

        method_name = path[len("/api/"):].strip("/")
        if method_name not in PUBLIC_METHODS:
            self._send_json({"error": f"unknown method {method_name!r}"}, 404)
            return
        method = getattr(self.api, method_name)

        try:
            kwargs = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            self._send_json({"error": f"bad JSON: {exc}"}, 400)
            return
        if not isinstance(kwargs, dict):
            self._send_json({"error": "body must be a JSON object"}, 400)
            return

        try:
            result = method(**kwargs)
        except TypeError as exc:
            self._send_json({"error": f"bad arguments: {exc}"}, 400)
            return
        except (ValueError, FileNotFoundError) as exc:
            # Bad input from the caller, not a server fault.
            self._send_json({"error": str(exc), "type": type(exc).__name__}, 400)
            return
        except Exception as exc:
            log.exception("api.%s failed", method_name)
            self._send_json({"error": str(exc), "type": type(exc).__name__}, 500)
            return

        self._send_json(result)


def make_server(api: Api, host: str = "127.0.0.1", port: int = 8731) -> ThreadingHTTPServer:
    handler = partial(Handler, api=api)
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def serve(host: str = "127.0.0.1", port: int = 8731, api: Api | None = None) -> None:
    api = api or Api()
    server = make_server(api, host, port)
    print(f"ChessHindsight dev server on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        server.shutdown()


def serve_background(
    api: Api, host: str = "127.0.0.1", port: int = 0
) -> tuple[ThreadingHTTPServer, str]:
    """Start a server on a background thread; returns (server, base_url)."""
    server = make_server(api, host, port)
    actual_port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True, name="http").start()
    return server, f"http://{host}:{actual_port}"


if __name__ == "__main__":
    serve()

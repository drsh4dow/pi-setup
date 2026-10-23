"""Serve the API over HTTP: python3 -m inventory.server"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from .api import ROLES, Api
from .store import Store


def parse_keys(text):
    """Return {key: role} from text like "ck_1:clerk,vk_1:viewer". Raises ValueError."""
    keys = {}
    for entry in text.split(","):
        entry = entry.strip()
        if not entry:
            continue
        key, _, role = entry.partition(":")
        if not key or role not in ROLES:
            raise ValueError(f"bad key entry {entry!r}; use KEY:viewer or KEY:clerk")
        keys[key] = role
    return keys


def handler_for(api):
    """Return a request handler class that answers every request with api."""

    class Handler(BaseHTTPRequestHandler):
        def _dispatch(self):
            length = int(self.headers.get("Content-Length") or 0)
            path = self.path.split("?", 1)[0]
            response = api.handle(self.command, path, self.headers, self.rfile.read(length))
            body = json.dumps(response.body).encode()
            self.send_response(response.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_PUT = do_DELETE = _dispatch

    return Handler


def main():
    """Serve until interrupted, configured by INVENTORY_DB, INVENTORY_KEYS, and PORT."""
    keys = parse_keys(os.environ.get("INVENTORY_KEYS", ""))
    store = Store(os.environ.get("INVENTORY_DB", "inventory.db"))
    server = HTTPServer(("127.0.0.1", int(os.environ.get("PORT", "8080"))), handler_for(Api(store, keys)))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("inventory: stopped", file=sys.stderr)
    finally:
        server.server_close()
        store.close()


if __name__ == "__main__":
    main()

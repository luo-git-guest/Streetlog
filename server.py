"""Serve Streetlog and its private, local route and photo library."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
STATIC_ROOT = ROOT / ("dist" if (ROOT / "dist").is_dir() else "docs")
API = "/api/library"
FOLDER_API = "/api/folder"
FOLDER_TYPES = {"routes": ("GeoJSON", {".geojson", ".json"}, "application/geo+json"),
                "photos": ("Photo", {".jpg", ".jpeg"}, "image/jpeg")}
COLLECTIONS = ("outings", "imports", "photos")
MAX_REQUEST = 100 * 1024 * 1024
library_lock = threading.Lock()


class StreetlogHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_ROOT), **kwargs)

    def read_library(self):
        try:
            return json.loads(self.server.library_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {collection: [] for collection in COLLECTIONS}

    def reply_json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def local_request(self):
        host = self.headers.get("Host", "")
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        return host in allowed and self.headers.get("Origin") in (None, f"http://{host}")

    def do_GET(self):
        if urlsplit(self.path).path == FOLDER_API:
            return self.get_folder()
        if self.path != API:
            return super().do_GET()
        if not self.local_request():
            return self.reply_json(403, {"error": "Use Streetlog on localhost."})
        try:
            library = self.read_library()
        except (OSError, ValueError):
            return self.reply_json(500, {"error": "Could not read the saved library."})
        return self.reply_json(200, library)

    def write_library(self, library):
        self.write_json(self.server.library_path, library)

    @staticmethod
    def write_json(path, data):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                         dir=path.parent, delete=False) as draft:
            temporary = Path(draft.name)
            try:
                json.dump(data, draft, separators=(",", ":"))
                draft.flush()
                os.fsync(draft.fileno())
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)

    @property
    def folder_config(self):
        return self.server.library_path.with_name("folder-preference.json")

    def configured_folder(self):
        try:
            path = Path(json.loads(self.folder_config.read_text(encoding="utf-8"))["path"])
            if path.is_dir() and not path.is_symlink():
                return path
        except FileNotFoundError:
            pass
        return None

    def folder_directory(self, root, kind):
        directory = root / FOLDER_TYPES[kind][0]
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError("Library subfolder is unavailable.")
        return directory

    @staticmethod
    def folder_key(root):
        return hashlib.sha256(os.fsencode(root)).hexdigest()

    def folder_file(self, root, params):
        if params.get("folder") != [self.folder_key(root)]:
            raise ValueError("The configured folder changed. Reload Streetlog.")
        kind, name = params["kind"][0], params["name"][0]
        if Path(name).name != name or Path(name).suffix.lower() not in FOLDER_TYPES[kind][1]:
            raise ValueError("Invalid library filename.")
        target = self.folder_directory(root, kind) / name
        if target.is_symlink():
            raise ValueError("Linked files are skipped.")
        return target, FOLDER_TYPES[kind][2]

    def get_folder(self):
        if not self.local_request():
            return self.reply_json(403, {"error": "Use Streetlog on localhost."})
        params = parse_qs(urlsplit(self.path).query)
        try:
            root = self.configured_folder()
            if not root:
                return self.reply_json(404 if params else 200, {"name": None})
            if not params:
                files = {}
                for kind, (_, extensions, _) in FOLDER_TYPES.items():
                    files[kind] = sorted(file.name for file in self.folder_directory(root, kind).iterdir()
                                         if not file.is_symlink() and file.is_file()
                                         and file.suffix.lower() in extensions)
                return self.reply_json(200, {"name": root.name, "key": self.folder_key(root), "files": files})
            path, content_type = self.folder_file(root, params)
            if not path.is_file():
                return self.reply_json(404, {"error": "File missing."})
            with path.open("rb") as source:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
                self.end_headers()
                shutil.copyfileobj(source, self.wfile)
        except (ValueError, TypeError, KeyError, OSError):
            return self.reply_json(400, {"error": "Could not read the configured library folder."})

    def configure_folder(self):
        if not self.local_request() or self.headers.get_content_type() != "application/json":
            return self.reply_json(403, {"error": "Use Streetlog on localhost."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Invalid request length.")
            path = Path(json.loads(self.rfile.read(length))["path"]).expanduser()
            if not path.is_absolute() or not path.is_dir():
                return self.reply_json(400, {"error": "Enter the full path of an existing folder."})
            path = path.resolve()
            for name, _, _ in FOLDER_TYPES.values():
                directory = path / name
                if directory.is_symlink():
                    raise ValueError("Linked subfolder.")
                directory.mkdir(exist_ok=True)
            self.write_json(self.folder_config, {"path": str(path)})
        except (ValueError, TypeError, KeyError, OSError):
            return self.reply_json(400, {"error": "Could not open or prepare that folder."})
        return self.get_folder()

    def do_PUT(self):
        if urlsplit(self.path).path != FOLDER_API:
            return self.reply_json(404, {"error": "Unknown endpoint."})
        if not self.local_request() or self.headers.get("X-Streetlog-Folder") != "1":
            return self.reply_json(403, {"error": "Use Streetlog on localhost."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_REQUEST:
                return self.reply_json(413, {"error": "File exceeds the 100 MB limit or is empty."})
            params = parse_qs(urlsplit(self.path).query)
            root = self.configured_folder()
            if root is None:
                raise ValueError("No folder selected.")
            path, _ = self.folder_file(root, params)
            with library_lock:
                if path.exists() and params.get("replace") != ["1"]:
                    return self.reply_json(200, {"saved": True})
                with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as draft:
                    temporary = Path(draft.name)
                    try:
                        remaining = size
                        while remaining:
                            chunk = self.rfile.read(min(remaining, 65536))
                            if not chunk:
                                raise ValueError("Incomplete file.")
                            draft.write(chunk)
                            remaining -= len(chunk)
                        draft.flush()
                        os.replace(temporary, path)
                    finally:
                        temporary.unlink(missing_ok=True)
        except (ValueError, TypeError, KeyError, OSError):
            return self.reply_json(400, {"error": "Could not write the folder file."})
        return self.reply_json(200, {"saved": True})

    def delete_folder_outing(self):
        if not self.local_request() or self.headers.get("X-Streetlog-Folder") != "1":
            return self.reply_json(403, {"error": "Use Streetlog on localhost."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Invalid request length.")
            identifier = json.loads(self.rfile.read(length))["id"]
            params = parse_qs(urlsplit(self.path).query)
            if not isinstance(identifier, str) or not identifier or params.get("kind") != ["routes"]:
                raise ValueError("Expected a recorded outing.")
            with library_lock:
                root = self.configured_folder()
                if root is None:
                    raise ValueError("No folder selected.")
                path, _ = self.folder_file(root, params)
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except FileNotFoundError:
                    return self.reply_json(200, {"deleted": True})
                if data.get("streetlogOuting", {}).get("id") != identifier:
                    raise ValueError("File does not match the recording.")
                path.unlink()
        except (ValueError, TypeError, KeyError, AttributeError, OSError):
            return self.reply_json(400, {"error": "Could not delete the recorded outing file."})
        return self.reply_json(200, {"deleted": True})

    def do_DELETE(self):
        if urlsplit(self.path).path == FOLDER_API:
            return self.delete_folder_outing()
        if self.path != API:
            return self.reply_json(404, {"error": "Unknown endpoint."})
        if not self.local_request():
            return self.reply_json(403, {"error": "Use Streetlog on localhost."})
        if self.headers.get_content_type() != "application/json":
            return self.reply_json(415, {"error": "Expected JSON."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Invalid request length")
            item = json.loads(self.rfile.read(length))
            collection, identifier = item["collection"], item["id"]
            if collection not in COLLECTIONS or not isinstance(identifier, str) or not identifier:
                raise ValueError("Invalid library entry")
        except (ValueError, TypeError, KeyError):
            return self.reply_json(400, {"error": "Invalid library entry."})
        try:
            with library_lock:
                library = self.read_library()
                remaining = [entry for entry in library[collection] if entry["id"] != identifier]
                if len(remaining) != len(library[collection]):
                    library[collection] = remaining
                    self.write_library(library)
        except (OSError, ValueError, TypeError):
            return self.reply_json(500, {"error": "Could not remove the saved item."})
        return self.reply_json(200, {"deleted": True})

    def do_POST(self):
        if self.path == FOLDER_API:
            return self.configure_folder()
        if self.path != API:
            return self.reply_json(404, {"error": "Unknown endpoint."})
        if not self.local_request():
            return self.reply_json(403, {"error": "Use Streetlog on localhost."})
        if self.headers.get_content_type() != "application/json":
            return self.reply_json(415, {"error": "Expected JSON."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_REQUEST:
                return self.reply_json(413, {"error": "Save exceeds the 100 MB request limit."})
            updates = json.loads(self.rfile.read(max(length, 0)))
            required = {"outings": {"segments"}, "imports": {"data"},
                        "photos": {"lat", "lng", "name", "image"}}
            for collection in COLLECTIONS:
                entries = updates[collection]
                if not isinstance(entries, list) or any(
                    not isinstance(entry, dict) or not isinstance(entry.get("id"), str)
                    or not required[collection].issubset(entry) for entry in entries
                ):
                    raise ValueError(collection)
        except (ValueError, TypeError, KeyError):
            return self.reply_json(400, {"error": "Invalid library data."})

        try:
            with library_lock:
                library = self.read_library()
                for collection in COLLECTIONS:
                    stored = {entry["id"]: entry for entry in library[collection]}
                    for entry in updates[collection]:
                        previous = stored.get(entry["id"])
                        if collection == "outings" and previous:
                            old_size = sum(map(len, previous["segments"]))
                            new_size = sum(map(len, entry["segments"]))
                            if old_size > new_size:
                                continue
                        stored[entry["id"]] = entry
                    library[collection] = list(stored.values())
                self.write_library(library)
        except (OSError, ValueError, TypeError):
            return self.reply_json(500, {"error": "Could not write the saved library."})
        return self.reply_json(200, {"saved": True})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--library", type=Path, default=ROOT / ".streetlog-data" / "library.json")
    options = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", options.port), StreetlogHandler) as server:
        server.library_path = options.library.resolve()
        print(f"Streetlog running at http://127.0.0.1:{server.server_port}/", flush=True)
        server.serve_forever()

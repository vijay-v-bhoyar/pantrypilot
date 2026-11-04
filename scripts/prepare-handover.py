"""Create an allowlisted credential-free source candidate, without publishing it.
Requires Python 3.10+. Never reads ignored env files or runtime stores.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile

ROOT_FILES = ["LICENSE", "package.json", "package-lock.json", "tsconfig.json", "next-env.d.ts",
              "next.config.ts", "postcss.config.mjs", "eslint.config.mjs",
              "vitest.config.ts", "playwright.config.ts", ".gitignore", "AGENTS.md", "AGENT-SECURITY.md", ".env.example",
              "scripts/owner-planner-stage.ps1"]
TREES = {"src": {".ts", ".tsx", ".css", ".ico"}, "scripts": {".ts", ".sql", ".py"},
         "tests": {".ts"}, "supabase/migrations": {".sql"},
         "docs/testing/next-local-01-v1": {".json", ".csv"}}
DOCS = ["docs/adoption/journey-contracts.json", "docs/handover/persona-workflows.json"]
PUBLIC_DOCS = {
    "README.md": "docs/public-source/README.md",
    "docs/planning/README.md": "docs/public-source/planning-index.md",
    "docs/planning/contracts.md": "docs/public-source/contracts.md",
    "docs/testing/next-local-01-v1/README.md": "docs/public-source/worksheets.md",
}
PATTERNS = [r"AIza[0-9A-Za-z_-]{20,}", r"eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}",
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", r"\[TRIAL\]_this_",
            r"[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail)\.com"]

def checked_file(root, relative):
    current = root
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Linked source refused")
    if not current.is_file():
        raise ValueError("Required source file missing")
    return current

def plan_files(root):
    root = Path(root).resolve()
    names = set(ROOT_FILES + DOCS)
    for tree, extensions in TREES.items():
        base = root / tree
        if base.is_symlink():
            raise ValueError("Linked source refused")
        for file in base.rglob("*"):
            if file.is_symlink():
                raise ValueError("Linked source refused")
            if file.is_file() and file.suffix in extensions:
                names.add(file.relative_to(root).as_posix())
    files = {name: checked_file(root, name) for name in sorted(names)}
    # Include each public document's source so exported source can package itself.
    # Private planning, submission and verification records stay outside the export.
    for target, source in PUBLIC_DOCS.items():
        files[source] = checked_file(root, source)
        files[target] = files[source]
    return dict(sorted(files.items()))

def validate_content(name, data):
    if name.endswith(".ico"):
        return
    text = data.decode("utf-8")
    if any(re.search(pattern, text, re.I) for pattern in PATTERNS):
        raise ValueError("Sensitive source content refused; no value is logged")
    if name == ".env.example":
        credential_names = ["SESSION_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
                            "SUPABASE_SERVICE_ROLE_KEY", "PAYPAL_MERCHANTS_JSON", "GEMINI_API_KEY",
                            "RECONCILE_TOKEN", "NEXT_PUBLIC_AG_STUDIO_LICENSE", "GEMINI_MODEL"]
        for key in credential_names:
            if any(line.startswith(key + "=") and line.partition("=")[2] for line in text.splitlines()):
                raise ValueError("Example credential must be blank")
        if "PROVIDER_ACTIONS_ENABLED=false" not in text or "AI_MODE=manual" not in text:
            raise ValueError("Unsafe example profile")

def build_bundle(root, destination):
    root = Path(root).resolve()
    destination = Path(destination).resolve()
    if not destination.is_relative_to(root / "output") or destination.suffix != ".zip":
        raise ValueError("Destination must be a fresh ZIP under workspace output")
    for parent in [destination.parent, *destination.parent.parents]:
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError("Linked destination refused")
    manifest_path = destination.with_suffix(".manifest.json")
    checksum_path = destination.with_suffix(".sha256")
    if any(p.exists() for p in [destination, manifest_path, checksum_path]):
        raise ValueError("Existing handover evidence must not be overwritten")
    files = {}
    for name, source in plan_files(root).items():
        data = source.read_bytes()
        validate_content(name, data)
        files[name] = data
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    source_digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest = {"schema_version": "pantrypilot-handover-v1", "source_digest": source_digest,
                "scope": "credential-free source export; no provider or deployment authorization", "files": hashes}
    manifest_data = (json.dumps(manifest, indent=2) + "\n").encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr("HANDOVER-MANIFEST.json", manifest_data)
    with manifest_path.open("xb") as handle:
        handle.write(manifest_data)
    checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
    with checksum_path.open("x", encoding="utf-8") as handle:
        handle.write(checksum + "  " + destination.name + "\n")
    return {"archive": str(destination), "sha256": checksum, "source_digest": source_digest, "file_count": len(files)}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(build_bundle(Path(__file__).resolve().parents[1], args.destination)))
    except (ValueError, OSError, UnicodeError):
        raise SystemExit("Handover blocked: invalid, private, linked or existing candidate. No credential values are logged.")

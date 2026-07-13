"""Storage layout.

Two tiers with different lifetimes, chosen so the public repo stays small
forever:

- ``raw/``   — full snapshot rows, needed only until their arrivals are
  resolved. Lives in the workflow cache (gitignored), pruned after 2 days.
- ``graded/``— one compact record per resolved arrival: the promise
  trajectory sampled at standard horizons, the inferred truth, and its
  uncertainty. ~2 MB/day gzipped; committed to git; the permanent record.

Files are gzip *multi-member* JSONL: appending writes a new gzip member,
which Python's gzip reader consumes transparently — append-safe without
rewriting the file.
"""

from __future__ import annotations

import gzip
import json
import time
from pathlib import Path


def append_jsonl_gz(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows)
    with open(path, "ab") as f:
        f.write(gzip.compress(payload.encode()))


def read_jsonl_gz(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def day_str(ts: int | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts if ts is not None else time.time()))


class Store:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.raw_dir = self.root / "raw"
        self.graded_dir = self.root / "graded"
        self.state_path = self.root / "state.json"

    def append_raw(self, agency: str, rows: list[dict], ts: int) -> None:
        append_jsonl_gz(self.raw_dir / day_str(ts) / f"{agency}.jsonl.gz", rows)

    def append_graded(self, agency: str, rows: list[dict], ts: int) -> None:
        append_jsonl_gz(self.graded_dir / f"{day_str(ts)}-{agency}.jsonl.gz", rows)

    def read_graded_days(self, days: int) -> list[dict]:
        cutoff = time.time() - days * 86400
        out: list[dict] = []
        for path in sorted(self.graded_dir.glob("*.jsonl.gz")):
            day = path.name[:10]
            if time.mktime(time.strptime(day, "%Y-%m-%d")) >= cutoff - 86400:
                out.extend(read_jsonl_gz(path))
        return out

    def load_state(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        return {}

    def save_state(self, state: dict) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(state, separators=(",", ":")))

    def prune_raw(self, keep_days: int = 2) -> list[str]:
        removed = []
        if not self.raw_dir.exists():
            return removed
        keep = {day_str(int(time.time()) - i * 86400) for i in range(keep_days)}
        for d in sorted(self.raw_dir.iterdir()):
            if d.is_dir() and d.name not in keep:
                for f in d.iterdir():
                    f.unlink()
                d.rmdir()
                removed.append(d.name)
        return removed

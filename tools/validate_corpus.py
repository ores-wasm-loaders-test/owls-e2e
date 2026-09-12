#!/usr/bin/env python3
"""Prove that corpus/release-corpus.json says the truth about release.schema.json.

The corpus is the shared authority for three language hosts. Before any host
runs it, this tool checks the corpus against the schema alone:

    expect = "schema"  ->  release.schema.json MUST reject it
    expect = "valid"   ->  release.schema.json MUST accept it
    expect = "host"    ->  release.schema.json MUST accept it
                           (the rejection is the host layer's job, so a case
                            that the schema already rejects is mislabelled)

Standard library plus `jsonschema` only. Exits non-zero with a per-case report
on any mismatch.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import jsonschema
except ImportError:  # pragma: no cover - environment problem, not a corpus problem
    sys.exit("jsonschema is required: pip install 'jsonschema>=4.20'")

REPO = Path(__file__).resolve().parent.parent
DEFAULT_CORPUS = REPO / "corpus" / "release-corpus.json"
DEFAULT_SCHEMA = (REPO / "zed_modules" / "ores-wasm-loaders" / "owls-interfaces"
                  / "schemas" / "release.schema.json")

EXPECTATIONS = ("valid", "schema", "host")
SCHEMA_MUST_ACCEPT = ("valid", "host")


def load_json(path: Path, what: str) -> object:
    if not path.is_file():
        sys.exit(f"{what} not found: {path}\n"
                 f"Run `zed install --frozen --install-mode copy --adapter node` first, "
                 f"or pass --schema/--corpus.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"{what} is not valid JSON: {path}: {e}")


def first_error(validator: "jsonschema.protocols.Validator", instance: object) -> str:
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
    if not errors:
        return ""
    e = errors[0]
    where = "/".join(str(p) for p in e.absolute_path) or "<root>"
    return f"{where}: {e.message}"


def check_shape(corpus: object, corpus_path: Path) -> list[dict]:
    if not isinstance(corpus, dict):
        sys.exit(f"{corpus_path}: corpus must be a JSON object")
    if corpus.get("schemaVersion") != 1:
        sys.exit(f"{corpus_path}: unsupported corpus schemaVersion "
                 f"{corpus.get('schemaVersion')!r}; this tool understands 1")
    cases = corpus.get("cases")
    if not isinstance(cases, list) or not cases:
        sys.exit(f"{corpus_path}: 'cases' must be a non-empty array")

    problems: list[str] = []
    seen: set[str] = set()
    for i, case in enumerate(cases):
        label = f"cases[{i}]"
        if not isinstance(case, dict):
            problems.append(f"{label}: not an object")
            continue
        name = case.get("name")
        if not isinstance(name, str) or not name:
            problems.append(f"{label}: missing 'name'")
            continue
        if name in seen:
            problems.append(f"{label} ({name}): duplicate case name")
        seen.add(name)
        if case.get("expect") not in EXPECTATIONS:
            problems.append(f"{name}: 'expect' must be one of {EXPECTATIONS}, "
                            f"got {case.get('expect')!r}")
        if not isinstance(case.get("reason"), str) or not case.get("reason"):
            problems.append(f"{name}: missing 'reason'")
        origins = case.get("origins")
        if not isinstance(origins, list) or not all(isinstance(o, str) for o in origins):
            problems.append(f"{name}: 'origins' must be an array of strings")
        if "release" not in case:
            problems.append(f"{name}: missing 'release'")
        if "code" in case:
            if case["expect"] == "valid":
                problems.append(f"{name}: a 'valid' case must not declare an error 'code'")
            if not isinstance(case["code"], str) or not case["code"]:
                problems.append(f"{name}: 'code' must be a non-empty string")
        if "deviation" in case:
            d = case["deviation"]
            if not isinstance(d, dict) or not isinstance(d.get("hosts"), list) \
                    or not isinstance(d.get("note"), str):
                problems.append(f"{name}: 'deviation' needs 'hosts' (array) and 'note' (string)")
    if problems:
        print("Corpus shape errors:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(2)
    return cases


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA,
                    help=f"path to release.schema.json (default: {DEFAULT_SCHEMA})")
    ap.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS,
                    help=f"path to release-corpus.json (default: {DEFAULT_CORPUS})")
    ap.add_argument("--quiet", action="store_true", help="only print the summary and failures")
    args = ap.parse_args()

    schema = load_json(args.schema, "schema")
    corpus = load_json(args.corpus, "corpus")
    cases = check_shape(corpus, args.corpus)

    cls = jsonschema.validators.validator_for(schema)
    cls.check_schema(schema)
    validator = cls(schema)

    failures: list[str] = []
    counts = {k: 0 for k in EXPECTATIONS}

    for case in cases:
        name, expect = case["name"], case["expect"]
        counts[expect] += 1
        error = first_error(validator, case["release"])
        accepted = error == ""
        if expect in SCHEMA_MUST_ACCEPT and not accepted:
            failures.append(
                f"{name}: expect={expect} requires the JSON Schema to ACCEPT this release, "
                f"but it was rejected -> {error}\n      reason given: {case['reason']}")
        elif expect == "schema" and accepted:
            failures.append(
                f"{name}: expect=schema requires the JSON Schema to REJECT this release, "
                f"but it validated cleanly.\n      reason given: {case['reason']}\n"
                f"      If the rejection really belongs to the host layer, relabel it expect=host.")
        elif not args.quiet:
            verdict = "accepted" if accepted else "rejected"
            print(f"  ok  {name:<48} schema {verdict}")

    total = len(cases)
    print(f"\n{args.corpus}")
    print(f"  schema : {args.schema}")
    print(f"  cases  : {total} "
          f"(valid={counts['valid']}, schema={counts['schema']}, host={counts['host']})")

    if failures:
        print(f"\n{len(failures)} case(s) disagree with the schema:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print("  result : every case's schema-level verdict matches its 'expect' label")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

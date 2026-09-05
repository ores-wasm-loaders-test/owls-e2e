# OWLS external consumer suite
Import installed packages from zed_modules; never a ../sibling source path.
corpus/release-corpus.json is the shared authority — change it only with tools/validate_corpus.py passing.
A case is expect:"host" only if the JSON Schema genuinely accepts it. Verify, do not guess.
Every sha256 is a real 64-hex digest; hash runtime bytes at runtime, never hardcode.
Missing inputs skip loudly with the reason. Never let an unrun suite report a pass.
Rust, Dart and the browser harness are gated on the consuming machine. Do not claim they ran.
Read ~/codes/AGENTS.md or .ores/agents/AGENTS.md when available. Never commit .ores/.

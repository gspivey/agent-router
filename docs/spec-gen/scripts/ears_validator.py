#!/usr/bin/env python3
"""
EARS Requirements Validator for spec-gen skill.

Checks requirements.md for common EARS (Easy Approach to Requirements Syntax)
violations: vague language, untestable acceptance criteria, missing measurability.

Rules:
  SHOULD_IN_REQUIREMENT  — "should" used where "shall"/"must" is required
  VAGUE_LANGUAGE         — unmeasurable qualifier found
  UNMEASURABLE_AC        — AC line has no measurable indicator (WARNING)
  INCOMPLETE_REQUIREMENT — TBD/TODO/PLACEHOLDER present
  EARS_TRIGGER_MISSING   — FR uses ubiquitous form with no trigger keyword (WARNING)

Exit codes:
  0 - no violations (or only warnings)
  1 - violations found (blocks review)
  2 - usage/env error

Usage:
  python3 ears_validator.py <requirements.md>
  python3 ears_validator.py .kiro/specs/libby-mcp/requirements.md
"""

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


# ── Rule definitions ──────────────────────────────────────────────────────────

# Vague qualifiers that make ACs untestable.
# Each entry: (pattern, context_exclusions)
# context_exclusions: if line also matches any of these, skip the flag.
VAGUE_QUALIFIERS: list[tuple[str, list[str]]] = [
    (r"\bshould\b", []),           # "should" vs "shall/must" — always flag in reqs
    (r"\breasonable\b", []),
    (r"\bappropriate\b", []),
    (r"\badequate\b", []),
    (r"\bsufficient\b", [r"sufficient context"]),  # "sufficient context for debugging" is still vague but common
    (r"\befficient\b", []),
    (r"\bfast\b", []),
    (r"\bquick(?:ly)?\b", []),
    (r"\bslow\b", []),
    (r"\bsimple\b", []),
    (r"\beasy\b", []),
    (r"\buser[-\s]?friendly\b", []),
    (r"\brobust\b", []),
    (r"\bscalable\b", []),
    (r"\bflexible\b", []),
    (r"\bgood\b", []),
    (r"\bbetter\b", []),
    (r"\bbest\b", [r"best[- ]effort"]),   # "best-effort" is a defined term, not a vague superlative
    (r"\boptimal\b", []),
    (r"\bminimal(?:ly)?\b", [r"minimal(?:ly)?\s+for", r"minimal(?:ly)?\s+viable"]),
    (r"\bmaximum\b", [r"maximum\s+\d", r"maximum\s+audiobook", r"max\s+\d"]),  # exclude "maximum N" forms
    (r"\bminimum\b", [r"minimum\s+\d"]),
    (r"\bsome\b", []),
    (r"\bmany\b", [r"as many as \d", r"how many"]),   # "as many as N" is fine
    (r"\bmost\b", []),
    (r"\bseveral\b", []),
    (r"\bvarious\b", []),
    (r"\busually\b", []),
    (r"\bgenerally\b", []),
    (r"\btypically\b", []),
    (r"\bnormally\b", []),
    (r"\boften\b", []),
]

# Normative keyword patterns — these imply testability when combined with verbs.
# Used by check_ac_measurability to accept normative-verb-based ACs as measurable.
NORMATIVE_KEYWORDS = [
    r"\bshall\b",
    r"\bmust\b",
]

# EARS trigger keyword patterns — structural markers for WHEN/WHILE/IF/WHERE/UNLESS
# conditions. These are NOT measurability signals on their own; they just indicate
# EARS event-driven or state-driven form. Used by check_ears_trigger.
EARS_TRIGGER_KEYWORDS = [
    r"\bwhen\b",
    r"\bwhile\b",
    r"\bwhere\b",
    r"\bif\b",
    r"\bunless\b",
]

# Combined list for any callers that need the full set (kept for compatibility).
EARS_KEYWORDS = NORMATIVE_KEYWORDS + EARS_TRIGGER_KEYWORDS

# Acceptance criteria markers
AC_PATTERN = re.compile(
    r"^(?:\s*[-*]\s*)?(?:AC[-\s]?\d+[\.\d]*|acceptance criteria|given|when|then)\b",
    re.IGNORECASE,
)

# Lines that are clearly ACs (numbered like AC-1.1, AC-3, etc.)
AC_LINE_PATTERN = re.compile(r"\bAC[-\s]?\d+[\.\d]*\b", re.IGNORECASE)

# Measurability indicators — if an AC has none of these, it may be untestable
MEASURABLE_INDICATORS = [
    r"\d+",                    # any number
    r"\b\d+\s*(?:ms|s|sec(?:ond)?s?|min(?:ute)?s?|h(?:our)?s?)\b",  # time
    r"\b\d+\s*(?:KB|MB|GB|TB|bytes?)\b",  # size
    r"\b\d+\s*(?:%|percent)\b",           # percentage
    r"\b(?:true|false|null|0|1)\b",        # boolean/null
    r"HTTP \d{3}",                          # HTTP status codes
    r"\b(?:must|shall)\s+(?:not\s+)?(?:return|emit|contain|include|exclude|raise|throw|call|create|delete|update)\b",
    r"(?:error|success|fail(?:ure)?|pass(?:ed)?)",  # outcome words
    r'"[^"]{1,80}"',                        # quoted string literals (expected values)
    r"'[^']{1,80}'",                        # single-quoted literals
    r"`[^`]{1,80}`",                        # backtick literals (code values)
    r"\[\s*\]|\{\s*\}",                     # empty collections
    r"\b(?:200|201|400|401|403|404|422|429|500|502|503)\b",  # HTTP codes
]


@dataclass
class Violation:
    line_num: int
    line: str
    rule: str
    detail: str
    severity: str = "ERROR"  # ERROR | WARNING


@dataclass
class ValidationResult:
    violations: list[Violation] = field(default_factory=list)
    warnings: list[Violation] = field(default_factory=list)
    ac_count: int = 0
    unmeasurable_acs: int = 0

    @property
    def has_errors(self) -> bool:
        return bool(self.violations)


def is_in_code_block(line: str, in_code: bool, code_fence: str) -> tuple[bool, str]:
    """Track code block state. Returns (new_in_code, fence_char)."""
    stripped = line.strip()
    if not in_code:
        if stripped.startswith("```") or stripped.startswith("~~~"):
            return True, stripped[:3]
        return False, ""
    else:
        if stripped.startswith(code_fence):
            return False, ""
        return True, code_fence


def is_comment_or_heading(line: str) -> bool:
    """Skip HTML comments and markdown headings for some checks."""
    stripped = line.strip()
    return stripped.startswith("<!--") or stripped.startswith("#")


def check_vague_language(line: str, line_num: int, result: ValidationResult) -> None:
    """Flag vague qualifiers in AC lines."""
    if is_comment_or_heading(line):
        return
    lower = line.lower()
    for pattern, exclusions in VAGUE_QUALIFIERS:
        if not re.search(pattern, lower):
            continue
        # Check context exclusions — if any match, skip this rule
        if any(re.search(excl, lower) for excl in exclusions):
            continue
        severity = "WARNING" if re.search(r"\bshould\b", lower) and pattern == r"\bshould\b" else "ERROR"
        match = re.search(pattern, lower)
        term = match.group(0) if match else pattern
        v = Violation(
            line_num=line_num,
            line=line.rstrip(),
            rule="VAGUE_LANGUAGE",
            detail=f'Vague qualifier "{term}" makes this untestable. Use a measurable value.',
            severity=severity,
        )
        if severity == "ERROR":
            result.violations.append(v)
        else:
            result.warnings.append(v)
        break  # one violation per line


def check_ac_measurability(line: str, line_num: int, result: ValidationResult) -> None:
    """Check that AC lines have at least one measurable indicator."""
    if not AC_LINE_PATTERN.search(line):
        return

    result.ac_count += 1

    # Check for any measurable indicator
    for pattern in MEASURABLE_INDICATORS:
        if re.search(pattern, line, re.IGNORECASE):
            return  # measurable — OK

    # Also accept normative keywords (shall/must) as implying testability when
    # combined with verbs. Trigger keywords (when/while/if/where/unless) are
    # structural markers only and do NOT indicate measurability on their own.
    for kw in NORMATIVE_KEYWORDS:
        if re.search(kw, line, re.IGNORECASE):
            return  # has normative verb — OK

    result.unmeasurable_acs += 1
    result.warnings.append(Violation(
        line_num=line_num,
        line=line.rstrip(),
        rule="UNMEASURABLE_AC",
        detail="AC has no measurable condition (number, HTTP code, boolean, quoted value, or EARS keyword).",
        severity="WARNING",
    ))


def check_shall_vs_should(line: str, line_num: int, result: ValidationResult) -> None:
    """
    In a requirements context, 'shall'/'must' are normative; 'should' is advisory.
    Flag 'should' in FR/NFR/AC lines as likely an RFC 2119 weakening.
    """
    if is_comment_or_heading(line):
        return
    # Only flag in lines that are clearly requirements (contain FR/NFR/AC markers)
    has_req_marker = bool(re.search(r"\b(?:FR|NFR|AC)[-\s]?\d+", line, re.IGNORECASE))
    if has_req_marker and re.search(r"\bshould\b", line, re.IGNORECASE):
        result.violations.append(Violation(
            line_num=line_num,
            line=line.rstrip(),
            rule="SHOULD_IN_REQUIREMENT",
            detail='"should" in a requirement is advisory (RFC 2119). Use "shall" or "must" for normative requirements.',
            severity="ERROR",
        ))


def check_tbd_placeholders(line: str, line_num: int, result: ValidationResult) -> None:
    """Flag TBD/TBD/TODO in requirements as incomplete."""
    if re.search(r"\b(?:TBD|TBA|TODO|FIXME|PLACEHOLDER)\b", line, re.IGNORECASE):
        result.violations.append(Violation(
            line_num=line_num,
            line=line.rstrip(),
            rule="INCOMPLETE_REQUIREMENT",
            detail="Placeholder found. Requirement is not finalized.",
            severity="ERROR",
        ))


def check_ears_trigger(line: str, line_num: int, result: ValidationResult) -> None:
    """
    Warn when a functional requirement uses ubiquitous EARS form (no trigger).

    Ubiquitous form: <Entity> SHALL <action> — valid EARS but weaker than
    event-driven (WHEN/WHILE/IF/WHERE) for property-based test extraction.
    This is a WARNING, not an error; it does not block the pipeline.
    """
    if is_comment_or_heading(line):
        return

    # Must be an FR line
    if not re.search(r"\bFR[-\s]?\d+", line, re.IGNORECASE):
        return

    # Must have a normative verb
    has_normative = any(re.search(kw, line, re.IGNORECASE) for kw in NORMATIVE_KEYWORDS)
    if not has_normative:
        return

    # If it already has a trigger keyword, it's not ubiquitous form — OK
    has_trigger = any(re.search(kw, line, re.IGNORECASE) for kw in EARS_TRIGGER_KEYWORDS)
    if has_trigger:
        return

    result.warnings.append(Violation(
        line_num=line_num,
        line=line.rstrip(),
        rule="EARS_TRIGGER_MISSING",
        detail=(
            "FR uses ubiquitous form (no WHEN/WHILE/IF/WHERE trigger). "
            "Kiro PBT extracts weaker properties without a trigger clause."
        ),
        severity="WARNING",
    ))


def validate(path: Path) -> ValidationResult:
    result = ValidationResult()
    in_code = False
    code_fence = ""

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception as e:
        print(f"ERROR: Cannot read {path}: {e}", file=sys.stderr)
        sys.exit(2)

    for i, line in enumerate(lines, 1):
        in_code, code_fence = is_in_code_block(line, in_code, code_fence)
        if in_code:
            continue

        check_vague_language(line, i, result)
        check_ac_measurability(line, i, result)
        check_shall_vs_should(line, i, result)
        check_tbd_placeholders(line, i, result)
        check_ears_trigger(line, i, result)

    return result


def format_violation(v: Violation) -> str:
    icon = "❌" if v.severity == "ERROR" else "⚠️ "
    return (
        f"  {icon} Line {v.line_num} [{v.rule}]\n"
        f"     {v.line[:120]}\n"
        f"     → {v.detail}"
    )


def main() -> int:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <requirements.md>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"ERROR: File not found: {path}", file=sys.stderr)
        return 2

    result = validate(path)

    # ── Report ────────────────────────────────────────────────────────────────
    print(f"\n=== EARS Validator: {path} ===")
    print(f"ACs found: {result.ac_count}  |  Unmeasurable: {result.unmeasurable_acs}")

    if result.violations:
        print(f"\n❌ {len(result.violations)} ERROR(s) found:\n")
        for v in result.violations:
            print(format_violation(v))
            print()

    if result.warnings:
        print(f"\n⚠️  {len(result.warnings)} WARNING(s) (non-blocking):\n")
        for v in result.warnings:
            print(format_violation(v))
            print()

    if not result.violations and not result.warnings:
        print("\n✅ No EARS violations found.")
        return 0

    if result.violations:
        print(f"\nVERDICT: FAIL — {len(result.violations)} error(s) must be fixed before review.")
        return 1
    else:
        print(f"\nVERDICT: PASS (with {len(result.warnings)} advisory warning(s))")
        return 0


if __name__ == "__main__":
    sys.exit(main())

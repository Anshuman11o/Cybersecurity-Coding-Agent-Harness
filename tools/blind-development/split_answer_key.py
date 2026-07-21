#!/usr/bin/env python3
"""
Blind-development split for OWASP Juice Shop.

Reads a pristine juice-shop clone (SRC) and produces:
  - WORK: a stripped "working copy" with all answer-key giveaways removed/neutralized
  - ANSWER: a mirror directory with everything that was stripped out, plus answer-key.json

This script is repo-preparation tooling, not part of the harness itself. It does not
hardcode which lines are vulnerable -- it only knows the syntactic markers Juice Shop
itself uses to tag its own training-mode giveaways (vuln-code-snippet comments,
challengeUtils.solveIf/notSolved scoring hooks, codefixes game data, etc.) and removes them.
"""
import json
import os
import re
import shutil
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/juice-shop-test")
WORK = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/juice-shop-work")
ANSWER = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("/tmp/juice-shop-answer")

answer_key = {
    "vuln_code_snippet_comments": [],
    "solve_conditions": [],
    "challenges_yaml_fields": [],
    "exploit_tests": [],
    "moved_wholesale": [],
}

# ---------------------------------------------------------------------------
# Phase 0: copy tree
# ---------------------------------------------------------------------------

def phase0_copy():
    if WORK.exists():
        shutil.rmtree(WORK)
    shutil.copytree(SRC, WORK, ignore=shutil.ignore_patterns(".git", "node_modules", "frontend_dist", "build"))
    print(f"[0] copied {SRC} -> {WORK}")


# ---------------------------------------------------------------------------
# Phase 1: strip vuln-code-snippet / # vuln-code-snippet comments, repo-wide
# ---------------------------------------------------------------------------

TAG_LINE_RE = re.compile(r'[ \t]*(?://|#)+[ \t]*vuln-code-snippet[ \t]+(\S+)(.*?)[ \t]*$')

TEXT_EXTS = {".ts", ".js", ".sol", ".yml", ".yaml", ".html", ".scss", ".css", ".md"}


def iter_text_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for fn in filenames:
            p = Path(dirpath) / fn
            if p.suffix in TEXT_EXTS:
                yield p


def phase1_strip_vuln_comments():
    count = 0
    files_touched = set()
    for p in iter_text_files(WORK):
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if "vuln-code-snippet" not in text:
            continue
        lines = text.split("\n")
        new_lines = []
        changed = False
        rel = str(p.relative_to(WORK))
        for lineno, line in enumerate(lines, start=1):
            m = TAG_LINE_RE.search(line)
            if not m:
                new_lines.append(line)
                continue
            tag = m.group(1)
            rest = m.group(2).strip()
            keys = rest.split() if rest else []
            prefix = line[: m.start()].rstrip()
            answer_key["vuln_code_snippet_comments"].append({
                "file": rel,
                "line": lineno,
                "tag": tag,
                "challengeKeys": keys,
                "originalLine": line,
            })
            count += 1
            changed = True
            if prefix == "":
                # standalone tag line (start/end/hide-start/hide-end) -> drop entirely
                continue
            new_lines.append(prefix)
        if changed:
            p.write_text("\n".join(new_lines), encoding="utf-8")
            files_touched.add(rel)
    print(f"[1] stripped {count} vuln-code-snippet tags across {len(files_touched)} files")


# ---------------------------------------------------------------------------
# Phase 2: move wholesale directories/files that are pure answer-key material
# ---------------------------------------------------------------------------

WHOLESALE_MOVES = [
    ("data/static/codefixes", "codefixes"),
    ("SOLUTIONS.md", "SOLUTIONS.md"),
    ("rsn", "rsn"),
    (".ai/skills/verify-rsn-fix", "ai-skills/verify-rsn-fix"),
    ("test/server/rsn.unit.test.ts", "tests/server/rsn.unit.test.ts"),
    ("test/server/codingChallengeFixes.unit.test.ts", "tests/server/codingChallengeFixes.unit.test.ts"),
]


def phase2_wholesale_moves():
    for src_rel, dst_rel in WHOLESALE_MOVES:
        src_path = WORK / src_rel
        dst_path = ANSWER / dst_rel
        if not src_path.exists():
            print(f"[2] WARNING: {src_rel} does not exist, skipping")
            continue
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        if src_path.is_dir():
            if dst_path.exists():
                shutil.rmtree(dst_path)
            shutil.copytree(src_path, dst_path)
            shutil.rmtree(src_path)
        else:
            shutil.copy2(src_path, dst_path)
            src_path.unlink()
        answer_key["moved_wholesale"].append({"from": src_rel, "to": dst_rel})
        print(f"[2] moved {src_rel} -> answer-key/{dst_rel}")

    # package.json: drop rsn/rsn:update scripts (their target files no longer exist)
    pkg_path = WORK / "package.json"
    pkg_text = pkg_path.read_text(encoding="utf-8")
    for line_pat in [
        r'[ \t]*"rsn":\s*"tsx rsn/rsn\.ts",?\n',
        r'[ \t]*"rsn:update":\s*"tsx rsn/rsn-update\.ts",?\n',
    ]:
        pkg_text, n = re.subn(line_pat, "", pkg_text)
        if n:
            print(f"[2] removed package.json script matching {line_pat!r}")
    pkg_path.write_text(pkg_text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Shared JS/TS-aware scanning helpers (string/template/comment-safe brace matching)
# ---------------------------------------------------------------------------

def skip_string(text: str, i: int) -> int:
    """text[i] is one of ' \" ` -- return index just past the matching close."""
    quote = text[i]
    i += 1
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if quote == "`" and text[i:i + 2] == "${":
            i += 2
            depth = 1
            while i < n and depth > 0:
                if text[i] in "\"'`":
                    i = skip_string(text, i)
                    continue
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                i += 1
            continue
        if c == quote:
            return i + 1
        i += 1
    return i


def find_matching(text: str, open_idx: int) -> int:
    """text[open_idx] is '(' or '{' -- return index of the matching close char."""
    open_c = text[open_idx]
    close_c = {"(": ")", "{": "}"}[open_c]
    depth = 1
    i = open_idx + 1
    n = len(text)
    while i < n and depth > 0:
        c = text[i]
        if c in "\"'`":
            i = skip_string(text, i)
            continue
        if text[i:i + 2] == "//":
            nl = text.find("\n", i)
            i = nl if nl != -1 else n
            continue
        if text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            i = end + 2 if end != -1 else n
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return i - 1


def split_top_level_args(text: str) -> list:
    """Split the inside of a (...) call into top-level comma-separated args."""
    args = []
    depth = 0
    start = 0
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in "\"'`":
            i = skip_string(text, i)
            continue
        if text[i:i + 2] == "//":
            nl = text.find("\n", i)
            i = nl if nl != -1 else n
            continue
        if text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            i = end + 2 if end != -1 else n
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            args.append(text[start:i])
            start = i + 1
        i += 1
    args.append(text[start:])
    return args


def line_of(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


# ---------------------------------------------------------------------------
# Phase 3: neutralize challengeUtils.solveIf(challenge, criteria, ...) calls, repo-wide
# ---------------------------------------------------------------------------

SOLVEIF_CALL_RE = re.compile(r"challengeUtils\.solveIf\s*\(")


def phase3_neutralize_solveif():
    count = 0
    files_touched = set()
    for p in iter_text_files(WORK):
        if p.suffix != ".ts":
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if "solveIf" not in text:
            continue
        rel = str(p.relative_to(WORK))
        edits = []  # (start, end, replacement)
        for m in SOLVEIF_CALL_RE.finditer(text):
            open_idx = m.end() - 1
            close_idx = find_matching(text, open_idx)
            inner = text[open_idx + 1:close_idx]
            args = split_top_level_args(inner)
            if len(args) < 2:
                continue  # malformed / not the pattern we expect
            challenge_arg = args[0].strip()
            criteria_arg = args[1]
            extra_args = args[2:]
            new_inner = challenge_arg + ", () => false"
            if extra_args:
                new_inner += "," + ",".join(extra_args)
            replacement = f"challengeUtils.solveIf({new_inner})"
            edits.append((m.start(), close_idx + 1, replacement))
            answer_key["solve_conditions"].append({
                "file": rel,
                "line": line_of(text, m.start()),
                "kind": "solveIf",
                "challenge": challenge_arg,
                "criteria": criteria_arg.strip(),
            })
            count += 1
        if edits:
            edits.sort(key=lambda e: e[0])
            out = []
            cursor = 0
            for start, end, repl in edits:
                out.append(text[cursor:start])
                out.append(repl)
                cursor = end
            out.append(text[cursor:])
            p.write_text("".join(out), encoding="utf-8")
            files_touched.add(rel)
    print(f"[3] neutralized {count} solveIf(...) criteria across {len(files_touched)} files")


# ---------------------------------------------------------------------------
# Phase 4: strip hints/description/mitigationUrl from challenges.yml
# ---------------------------------------------------------------------------

def phase4_strip_challenges_yaml():
    import yaml
    yml_path = WORK / "data/static/challenges.yml"
    data = yaml.safe_load(yml_path.read_text(encoding="utf-8"))
    # NOTE: fields are replaced with safe empty defaults rather than deleted.
    # data/datacreator.ts does `description.replace(...)` unconditionally at
    # server startup with no null-check, so an absent `description` key would
    # crash app boot. hints/mitigationUrl access sites *are* null-safe, but we
    # zero them the same way for consistency with the StaticChallenge type.
    safe_defaults = {"hints": [], "description": "", "mitigationUrl": ""}
    for entry in data:
        rec = {"key": entry.get("key")}
        for f, default in safe_defaults.items():
            if f in entry:
                rec[f] = entry[f]
                entry[f] = default
        answer_key["challenges_yaml_fields"].append(rec)
    yml_path.write_text(
        yaml.dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False, width=1000),
        encoding="utf-8",
    )
    print(f"[4] stripped hints/description/mitigationUrl from {len(data)} challenges.yml entries")


# ---------------------------------------------------------------------------
# Phase 5: split exploit-payload test cases out of test/api + cypress e2e specs
# ---------------------------------------------------------------------------

IT_CALL_RE = re.compile(r"(?:void\s+)?\bit(?:\.(?:only|skip))?\s*\(")

ATTACK_TITLE_RE = re.compile(
    r"(?i)\b("
    r"sql injection|nosql injection|command injection|ldap injection|injection attack|"
    r"xss|xxe|ssrf|ssti|csrf|"
    r"attack|exploit|bypass|forged|tamper|malicious|hack(?:ed|ing)?|poison null byte|"
    r"traversal|prototype pollution|escalat|deserializ|union select|"
    r"billion laughs|quadratic blowup|sandbox breakout|endless loop|"
    r"negative (?:quantity|total|order)|susceptible to|"
    r"forcibly comment|where[- ]clause|logically deleted"
    r")\b"
)

PAYLOAD_BODY_RE = re.compile(
    r"(?i)(union\s+select|<script|<!entity|<!doctype|__proto__|\.\./\.\./|%2e%2e|"
    r"eyJhbGciOiJub25lIn0|\$where\b|%00|javascript:|onerror\s*=|"
    r"'\s*\)*\s*--|'\s*(?:or|OR)\s|;\s*--|"
    r"challenges\.\w+Challenge\.solved\b)"
)

TEST_FILE_GLOBS = ["test/api/*.test.ts", "test/cypress/e2e/*.spec.ts", "test/server/*.unit.test.ts"]


def extract_it_blocks(text: str):
    """Return list of (start, end, title_or_None, body_text) for each top-level it(...) call."""
    blocks = []
    for m in IT_CALL_RE.finditer(text):
        open_idx = m.end() - 1
        # skip if this isn't actually the call we think (already inside a prior block)
        close_idx = find_matching(text, open_idx)
        inner = text[open_idx + 1:close_idx]
        args = split_top_level_args(inner)
        title = None
        if args:
            t = args[0].strip()
            tm = re.match(r"""^(['"])(.*)\1$""", t, re.S)
            if tm:
                title = tm.group(2)
        # include leading "void " token and preceding indentation, plus trailing newline
        start = m.start()
        end = close_idx + 1
        blocks.append((start, end, title, inner))
    return blocks


def dedupe_nested(blocks):
    """IT_CALL_RE can (rarely) match something inside a nested call's body; keep only
    outermost, non-overlapping blocks."""
    blocks = sorted(blocks, key=lambda b: b[0])
    out = []
    last_end = -1
    for b in blocks:
        if b[0] >= last_end:
            out.append(b)
            last_end = b[1]
    return out


def classify_exploit(title, body):
    if "expectChallengeSolved(" in body:
        return True
    if title and ATTACK_TITLE_RE.search(title):
        return True
    if PAYLOAD_BODY_RE.search(body):
        return True
    return False


def line_span_text(text, start, end):
    """Widen [start,end) to whole lines (including trailing newline) for clean removal."""
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    line_end = line_end + 1 if line_end != -1 else len(text)
    return line_start, line_end


def merge_spans(spans):
    spans = sorted(spans)
    merged = []
    for ls, le, tag in spans:
        if merged and ls <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], le), merged[-1][2] + [tag])
        else:
            merged.append((ls, le, [tag]))
    return merged


def remove_spans(text, spans):
    out = []
    cursor = 0
    for ls, le, _tags in spans:
        out.append(text[cursor:ls])
        cursor = le
    out.append(text[cursor:])
    return "".join(out)


def phase5_split_exploit_tests():
    import glob
    total_exploit = 0
    files_split = 0
    for pattern in TEST_FILE_GLOBS:
        for fpath in sorted(glob.glob(str(WORK / pattern))):
            p = Path(fpath)
            text = p.read_text(encoding="utf-8")
            raw_blocks = extract_it_blocks(text)
            blocks = dedupe_nested(raw_blocks)

            exploit_line_spans = []
            functional_line_spans = []
            for start, end, title, body in blocks:
                ls, le = line_span_text(text, start, end)
                if classify_exploit(title, body):
                    exploit_line_spans.append((ls, le, title))
                else:
                    functional_line_spans.append((ls, le, title))

            if not exploit_line_spans:
                continue

            rel = str(p.relative_to(WORK))
            exploit_merged = merge_spans(exploit_line_spans)
            functional_merged = merge_spans(functional_line_spans)

            work_text = remove_spans(text, exploit_merged)          # drop exploit -> keep functional
            answer_text = remove_spans(text, functional_merged)     # drop functional -> keep exploit

            for _, _, titles in exploit_merged:
                for t in titles:
                    answer_key["exploit_tests"].append({
                        "file": rel,
                        "title": t,
                        "movedTo": f"tests/{rel}",
                    })
                    total_exploit += 1

            p.write_text(work_text, encoding="utf-8")
            answer_mirror = ANSWER / "tests" / rel
            answer_mirror.parent.mkdir(parents=True, exist_ok=True)
            answer_mirror.write_text(answer_text, encoding="utf-8")
            files_split += 1
    print(f"[5] split {total_exploit} exploit test case(s) out of {files_split} test files")


# ---------------------------------------------------------------------------
# Phase 6: hand-verified neutralization of the notSolved(...)/solve(...) inline
# scoring-oracle pattern (a second, separate mechanism from solveIf, used in a
# handful of files). Each entry was read in full and confirmed to have no
# other observable side effect before being cut; the removed text is recorded
# in the answer key. This is intentionally NOT a generic repo-wide pass -- see
# docs/BLIND_DEVELOPMENT.md for why.
# ---------------------------------------------------------------------------

NOTSOLVED_PATCHES = [
    ("routes/login.ts", "loginAdminChallenge, ghostLoginChallenge, ephemeralAccountantChallenge",
     """    challengeUtils.solveIf(challenges.ghostLoginChallenge, () => false)
    if (challengeUtils.notSolved(challenges.ephemeralAccountantChallenge) && user.email === 'acc0unt4nt@' + config.get<string>('application.domain') && user.role === 'accounting') {
      UserModel.count({ where: { email: 'acc0unt4nt@' + config.get<string>('application.domain') } }).then((count: number) => {
        if (count === 0) {
          challengeUtils.solve(challenges.ephemeralAccountantChallenge)
        }
      }).catch(() => {
        throw new Error('Unable to verify challenges! Try again')
      })
    }
  }""",
     """    challengeUtils.solveIf(challenges.ghostLoginChallenge, () => false)
  }"""),

    ("routes/search.ts", "unionSqlInjectionChallenge, dbSchemaChallenge",
     """import * as utils from '../lib/utils'
import * as models from '../models/index'
import { UserModel } from '../models/user'
import { challenges } from '../data/datacache'
import * as challengeUtils from '../lib/challengeUtils'

class ErrorWithParent extends Error {
  parent: Error | undefined
}""",
     """import * as utils from '../lib/utils'
import * as models from '../models/index'

class ErrorWithParent extends Error {
  parent: Error | undefined
}"""),

    ("routes/search.ts", "unionSqlInjectionChallenge, dbSchemaChallenge (detection body)",
     """        const dataString = JSON.stringify(products)
        if (challengeUtils.notSolved(challenges.unionSqlInjectionChallenge)) {
          let solved = true
          UserModel.findAll().then(data => {
            const users = utils.queryResultToJson(data)
            if (users.data?.length) {
              for (let i = 0; i < users.data.length; i++) {
                solved = solved && utils.containsOrEscaped(dataString, users.data[i].email) && utils.contains(dataString, users.data[i].password)
                if (!solved) {
                  break
                }
              }
              if (solved) {
                challengeUtils.solve(challenges.unionSqlInjectionChallenge)
              }
            }
          }).catch((error: Error) => {
            next(error)
          })
        }
        if (challengeUtils.notSolved(challenges.dbSchemaChallenge)) {
          let solved = true
          void models.sequelize.query('SELECT sql FROM sqlite_master').then(([data]: any) => {
            const tableDefinitions = utils.queryResultToJson(data)
            if (tableDefinitions.data?.length) {
              for (let i = 0; i < tableDefinitions.data.length; i++) {
                if (tableDefinitions.data[i].sql) {
                  solved = solved && utils.containsOrEscaped(dataString, tableDefinitions.data[i].sql)
                  if (!solved) {
                    break
                  }
                }
              }
              if (solved) {
                challengeUtils.solve(challenges.dbSchemaChallenge)
              }
            }
          })
        }
        for (let i = 0; i < products.length; i++) {""",
     """        for (let i = 0; i < products.length; i++) {"""),

    ("routes/fileUpload.ts", "xxeDosChallenge",
     """        if (utils.contains(errorMessage, 'Script execution timed out')) {
          if (challengeUtils.notSolved(challenges.xxeDosChallenge)) {
            challengeUtils.solve(challenges.xxeDosChallenge)
          }
          res.status(503)""",
     """        if (utils.contains(errorMessage, 'Script execution timed out')) {
          res.status(503)"""),

    ("routes/fileUpload.ts", "yamlBombChallenge",
     """        if (utils.contains(errorMessage, 'Invalid string length') || utils.contains(errorMessage, 'Script execution timed out')) {
          if (challengeUtils.notSolved(challenges.yamlBombChallenge)) {
            challengeUtils.solve(challenges.yamlBombChallenge)
          }
          res.status(503)""",
     """        if (utils.contains(errorMessage, 'Invalid string length') || utils.contains(errorMessage, 'Script execution timed out')) {
          res.status(503)"""),

    ("routes/restoreProgress.ts", "continueCodeChallenge (magic id 999)",
     """    const ids = hashids.decode(continueCode)
    if (challengeUtils.notSolved(challenges.continueCodeChallenge) && ids.includes(999)) {
      challengeUtils.solve(challenges.continueCodeChallenge)
      res.end()
    } else if (ids.length > 0) {""",
     """    const ids = hashids.decode(continueCode)
    if (ids.length > 0) {"""),

    ("routes/verify.ts", "captchaBypassChallenge (timing criteria)",
     """export const captchaBypassChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  if (challengeUtils.notSolved(challenges.captchaBypassChallenge)) {
    if (req.app.locals.captchaReqId >= 10) {
      if ((new Date().getTime() - req.app.locals.captchaBypassReqTimes[req.app.locals.captchaReqId - 10]) <= 20000) {
        challengeUtils.solve(challenges.captchaBypassChallenge)
      }
    }
    req.app.locals.captchaBypassReqTimes[req.app.locals.captchaReqId - 1] = new Date().getTime()
    req.app.locals.captchaReqId++
  }
  next()
}""",
     """export const captchaBypassChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  if (challengeUtils.notSolved(challenges.captchaBypassChallenge)) {
    req.app.locals.captchaBypassReqTimes[req.app.locals.captchaReqId - 1] = new Date().getTime()
    req.app.locals.captchaReqId++
  }
  next()
}"""),

    ("routes/verify.ts", "sstiChallenge, ssrfChallenge (hidden debug-key endpoint)",
     """export const serverSideChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  if (req.query.key === 'tRy_H4rd3r_n0thIng_iS_Imp0ssibl3') {
    if (challengeUtils.notSolved(challenges.sstiChallenge) && req.app.locals.abused_ssti_bug === true) {
      challengeUtils.solve(challenges.sstiChallenge)
      res.status(204).send()
      return
    }

    if (challengeUtils.notSolved(challenges.ssrfChallenge) && req.app.locals.abused_ssrf_bug === true) {
      challengeUtils.solve(challenges.ssrfChallenge)
      res.status(204).send()
      return
    }
  }
  next()
}""",
     """export const serverSideChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}"""),

    ("routes/verify.ts", "jwtChallenge criteria helpers (dead after solveIf neutralization)",
     """function hasAlgorithm (token: string, algorithm: string) {
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString())
  return token && header && header.alg === algorithm
}

function hasEmail (token: { data: { email: string } }, email: string | RegExp) {
  return token?.data?.email?.match(email)
}

async function checkPatternInFeedbackAndComplaints (""",
     """async function checkPatternInFeedbackAndComplaints ("""),

    ("routes/verify.ts", "databaseRelatedChallenges cluster (12 detection helpers)",
     """async function checkPatternInFeedbackAndComplaints (
  challenge: Challenge,
  fieldCriteria: any
): Promise<void> {
  const feedbackCheck = FeedbackModel.findAndCountAll({
    where: { comment: fieldCriteria }
  }).then(({ count }: { count: number }) => {
    if (count > 0) {
      challengeUtils.solve(challenge)
    }
  }).catch(() => {
    throw new Error('Unable to retrieve feedback details. Please try again')
  })

  const complaintCheck = ComplaintModel.findAndCountAll({
    where: { message: fieldCriteria }
  }).then(({ count }: { count: number }) => {
    if (count > 0) {
      challengeUtils.solve(challenge)
    }
  }).catch(() => {
    throw new Error('Unable to retrieve complaint details. Please try again')
  })

  await Promise.all([feedbackCheck, complaintCheck])
}

export const databaseRelatedChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  if (challengeUtils.notSolved(challenges.changeProductChallenge) && products.osaft) {
    changeProductChallenge(products.osaft)
  }
  if (challengeUtils.notSolved(challenges.feedbackChallenge)) {
    feedbackChallenge()
  }
  if (challengeUtils.notSolved(challenges.knownVulnerableComponentChallenge)) {
    knownVulnerableComponentChallenge()
  }
  if (challengeUtils.notSolved(challenges.weirdCryptoChallenge)) {
    weirdCryptoChallenge()
  }
  if (challengeUtils.notSolved(challenges.typosquattingNpmChallenge)) {
    typosquattingNpmChallenge()
  }
  if (challengeUtils.notSolved(challenges.typosquattingAngularChallenge)) {
    typosquattingAngularChallenge()
  }
  if (challengeUtils.notSolved(challenges.hiddenImageChallenge)) {
    hiddenImageChallenge()
  }
  if (challengeUtils.notSolved(challenges.supplyChainAttackChallenge)) {
    supplyChainAttackChallenge()
  }
  if (challengeUtils.notSolved(challenges.dlpPastebinDataLeakChallenge)) {
    dlpPastebinDataLeakChallenge()
  }
  if (challengeUtils.notSolved(challenges.csafChallenge)) {
    csafChallenge()
  }
  if (challengeUtils.notSolved(challenges.leakedApiKeyChallenge)) {
    leakedApiKeyChallenge()
  }
  if (challengeUtils.notSolved(challenges.systemPromptExtractionChallenge)) {
    void systemPromptExtractionChallenge()
  }
  next()
}

function changeProductChallenge (osaft: Product) {
  let urlForProductTamperingChallenge: string | null = null
  void osaft.reload().then(() => {
    for (const product of config.get<ProductConfig[]>('products')) {
      if (product.urlForProductTamperingChallenge !== undefined) {
        urlForProductTamperingChallenge = product.urlForProductTamperingChallenge
        break
      }
    }
    if (urlForProductTamperingChallenge) {
      if (!utils.contains(osaft.description, `${urlForProductTamperingChallenge}`)) {
        if (utils.contains(osaft.description, `<a href="${config.get<string>('challenges.overwriteUrlForProductTamperingChallenge')}" target="_blank">`)) {
          challengeUtils.solve(challenges.changeProductChallenge)
        }
      }
    }
  })
}

function feedbackChallenge () {
  FeedbackModel.findAndCountAll({ where: { rating: 5 } }).then(({ count }: { count: number }) => {
    if (count === 0) {
      challengeUtils.solve(challenges.feedbackChallenge)
    }
  }).catch(() => {
    throw new Error('Unable to retrieve feedback details. Please try again')
  })
}

function knownVulnerableComponentChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.knownVulnerableComponentChallenge,
    { [Op.or]: knownVulnerableComponents() }
  )
}

function knownVulnerableComponents () {
  return [
    {
      [Op.and]: [
        { [Op.like]: '%sanitize-html%' },
        { [Op.like]: '%1.4.2%' }
      ]
    },
    {
      [Op.and]: [
        { [Op.like]: '%express-jwt%' },
        { [Op.like]: '%0.1.3%' }
      ]
    }
  ]
}

function weirdCryptoChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.weirdCryptoChallenge,
    { [Op.or]: weirdCryptos() }
  )
}

function weirdCryptos () {
  return [
    { [Op.like]: '%z85%' },
    { [Op.like]: '%base85%' },
    { [Op.like]: '%hashids%' },
    { [Op.like]: '%md5%' },
    { [Op.like]: '%base64%' }
  ]
}

function typosquattingNpmChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.typosquattingNpmChallenge,
    { [Op.like]: '%epilogue-js%' }
  )
}

function typosquattingAngularChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.typosquattingAngularChallenge,
    { [Op.like]: '%ngy-cookie%' }
  )
}

function hiddenImageChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.hiddenImageChallenge,
    { [Op.like]: '%pickle rick%' }
  )
}

function supplyChainAttackChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.supplyChainAttackChallenge,
    { [Op.or]: eslintScopeVulnIds() }
  )
}

function eslintScopeVulnIds () {
  return [
    { [Op.like]: '%eslint-scope/issues/39%' },
    { [Op.like]: '%npm:eslint-scope:20180712%' }
  ]
}

function dlpPastebinDataLeakChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.dlpPastebinDataLeakChallenge,
    { [Op.and]: dangerousIngredients() }
  )
}

function csafChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.csafChallenge,
    { [Op.like]: '%' + config.get<string>('challenges.csafHashValue') + '%' }
  )
}

function leakedApiKeyChallenge () {
  void checkPatternInFeedbackAndComplaints(
    challenges.leakedApiKeyChallenge,
    { [Op.like]: '%6PPi37DBxP4lDwlriuaxP15HaDJpsUXY5TspVmie%' }
  )
}

function dangerousIngredients () {
  return config.get<ProductConfig[]>('products')
    .flatMap((product) => product.keywordsForPastebinDataLeakChallenge)
    .filter(Boolean)
    .map((keyword) => {
      return { [Op.like]: `%${keyword}%` }
    })
}

export const SYSTEM_PROMPT_SIMILARITY_THRESHOLD = 0.25""",
     """export const databaseRelatedChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

export const SYSTEM_PROMPT_SIMILARITY_THRESHOLD = 0.25"""),

    ("routes/verify.ts", "systemPromptExtractionChallenge wrapper (keep exported similarity fns)",
     """export function checkSystemPromptSimilarity (submission: string, reference: string, threshold = SYSTEM_PROMPT_SIMILARITY_THRESHOLD): boolean {
  const score = diceCoefficient((submission ?? '').toLowerCase().trim(), reference.toLowerCase().trim())
  return score >= threshold
}

async function systemPromptExtractionChallenge (): Promise<void> {
  const reference = buildSystemPrompt().toLowerCase().trim()
  const complaints = await ComplaintModel.findAll().catch(() => [])
  for (const complaint of complaints) {
    if (checkSystemPromptSimilarity(complaint.message ?? '', reference)) {
      challengeUtils.solveIf(challenges.systemPromptExtractionChallenge, () => false)
      return
    }
  }
}""",
     """export function checkSystemPromptSimilarity (submission: string, reference: string, threshold = SYSTEM_PROMPT_SIMILARITY_THRESHOLD): boolean {
  const score = diceCoefficient((submission ?? '').toLowerCase().trim(), reference.toLowerCase().trim())
  return score >= threshold
}"""),

    ("routes/verify.ts", "now-unused imports after cluster removal",
     """import { type Request, type Response, type NextFunction } from 'express'
import { Op } from 'sequelize'
import jwt from 'jsonwebtoken'
import config from 'config'
import jws from 'jws'

import { products, challenges, retrieveBlueprintChallengeFile } from '../data/datacache'
import type { Product as ProductConfig } from '../lib/config.schema'
import { type Challenge, type Product } from '../data/types'
import * as challengeUtils from '../lib/challengeUtils'
import { ComplaintModel } from '../models/complaint'
import { FeedbackModel } from '../models/feedback'
import * as security from '../lib/insecurity'
import * as utils from '../lib/utils'
import { buildSystemPrompt } from './chat'""",
     """import { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import jws from 'jws'

import { challenges } from '../data/datacache'
import { type Challenge } from '../data/types'
import * as challengeUtils from '../lib/challengeUtils'
import * as security from '../lib/insecurity'
import * as utils from '../lib/utils'"""),
]


def phase6_neutralize_notsolved_patterns():
    count = 0
    for rel, label, old, new in NOTSOLVED_PATCHES:
        p = WORK / rel
        text = p.read_text(encoding="utf-8")
        n = text.count(old)
        if n != 1:
            raise RuntimeError(f"[6] expected exactly 1 occurrence of {label!r} in {rel}, found {n}")
        p.write_text(text.replace(old, new, 1), encoding="utf-8")
        answer_key["solve_conditions"].append({
            "file": rel,
            "kind": "notSolvedBlock",
            "label": label,
            "removedText": old,
        })
        count += 1
    print(f"[6] neutralized {count} hand-verified notSolved/solve blocks")


if __name__ == "__main__":
    phase0_copy()
    phase1_strip_vuln_comments()
    phase2_wholesale_moves()
    phase3_neutralize_solveif()
    phase4_strip_challenges_yaml()
    phase5_split_exploit_tests()
    phase6_neutralize_notsolved_patterns()
    ANSWER.mkdir(parents=True, exist_ok=True)
    (ANSWER / "answer-key.json").write_text(json.dumps(answer_key, indent=2), encoding="utf-8")
    print("All phases complete.")

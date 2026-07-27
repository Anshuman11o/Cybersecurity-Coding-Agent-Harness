# Dispatch — Add "Distinguishing From Adjacent Classes" to all 15 playbooks

Mechanical edit. Fifteen files, one new section each. The exact text is supplied below —
insert it verbatim. Do not paraphrase, reorder, reword, or "improve" it, and do not add
sections to files not listed.

## Why

Every playbook already has `## Distinguishing Real Findings from False Positives`, which
answers *"is this real?"* within a class. Nothing answers *"which class is this?"* — so
when two classes are both plausible, the model picks by vibe. Measured on the last run,
that is the single largest source of scoring loss: of the findings that landed on the
right code within line slack, 30 carried the wrong class. Two classes absorb most of the
wrong picks; two others are the most frequently displaced.

These sections are the missing half: a class-selection rule, stated as a boundary between
this class and the ones adjacent to it.

## Where the section goes

In each file, insert the new section **after** `## Distinguishing Real Findings from False
Positives` and **immediately before** `## Hunting Discipline`. One blank line either side,
matching the spacing already used between sections. Nothing else in the file changes — not
the scope line, not the categories list, not the sink patterns, not the hunting discipline
steps.

The files are in `tools/scanner/stage2-hunt-lanes-perfile/src/playbooks/`. Each exports a
single template literal named `playbook`. The inserted text lives inside that literal.

**Backticks and `${` do not appear in any of the text below.** If you think you need to
escape something, you have mistranscribed it — re-read the source.

## Do not touch

- `tools/scanner/stage2-hunt-lanes/src/playbooks/` — that is v1, a separate load-bearing
  component. Only the `-perfile` directory changes.
- `tools/scanner/stage3-validate/`, `tools/scanner/stage05-lane-selector*/`,
  `tools/scanner/stage0-recon/`, `tools/scanner/stage1-budget-governor/`.
- `hunt-executor.ts`, the response schema, `finding_classes`, the per-lane class enum,
  `vuln-classes.json`, `signal-classes.json`.
- Any stage output directory. **Do not run any stage.** Build and type-check only.

---

## The text to insert

### access-control.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the check exists but the identity it trusts was forged, replayed, or weakly derived —
  that is crypto-auth, an authentication failure rather than an authorization one
- the record is legitimately the caller's and the problem is which fields cross the
  boundary — that is api-property-auth
- the caller controls a value that changes how the query is parsed, rather than which
  record it returns — that is injection
- no check exists anywhere and none was ever designed for this flow — that is
  insecure-design; access-control means a check exists and is bypassable
- the gap is an option, default, or permission set to an unsafe value rather than a
  missing check in application logic — that is misconfiguration

Choose access-control when a check is present and reachable but does not bind the
resource or the function to the identity of the caller.
```

### crypto-auth.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the identity is established correctly and the gap is that a verified caller reaches a
  resource that is not theirs — that is access-control
- the weak value is a framework or library option left at an unsafe default rather than
  an algorithm or protocol implemented incorrectly here — that is misconfiguration
- the algorithm is sound but the library version implementing it is known-vulnerable —
  that is vulnerable-components
- the secret is handled correctly but written to a log, trace, or error response — that
  is logging-monitoring
- the flow is authenticated correctly and the design still permits the abuse — that is
  insecure-design

Choose crypto-auth when the secret, token, hash, or identity proof is itself forgeable,
guessable, replayable, or protected by an algorithm inadequate for its purpose.
```

### injection.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the input selects which record is returned without altering how the query is parsed —
  that is access-control
- the input names a host, URL, or path the server then fetches — that is ssrf
- the input is deserialized or executed because it was accepted without an integrity
  check, rather than because it was concatenated into a statement — that is
  integrity-failures
- the sink executes in the user's browser rather than on the server — that is client-side
- the interpreter is safe and the defect is a parser or engine option enabling a
  dangerous feature, such as entity expansion or code evaluation — that is
  misconfiguration
- the input is well-formed and bounded, and the harm is the volume of work it causes —
  that is resource-consumption

Choose injection when caller-controlled data changes how a downstream interpreter parses
or executes its input, rather than merely what that input selects.
```

### insecure-design.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- a check exists for this flow and can be bypassed — that is access-control; insecure-design
  means no control was omitted because none was ever conceived
- the flow is sound and a setting, default, or option carries an unsafe value — that is
  misconfiguration
- caller data reaches an interpreter and changes how it parses — that is injection
- the design is sound and the identity proof protecting it is weak — that is crypto-auth
- the design is sound and the abuse is a legitimate operation repeated at scale — that is
  sensitive-business-flows

Choose insecure-design when the code does exactly what it was designed to do, and the
design itself permits the abuse — so no single added check would close it.
```

### misconfiguration.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the setting is correct and application logic fails to bind a resource to its caller —
  that is access-control
- the setting is correct and caller data reaches an interpreter that parses it — that is
  injection
- the dangerous value is a dependency version rather than an option — that is
  vulnerable-components
- the workflow itself permits the abuse regardless of how it is configured — that is
  insecure-design

Choose misconfiguration when an option, default, flag, permission, header, or exposed
surface carries an unsafe value. The code is correct; the setting is wrong. This is a
property of a value, not of a code shape, so it can appear in any file — a parser allowing
entity expansion, an upload with no size limit, a handler with directory listing enabled,
a permissive cross-origin policy, a debug or verbose mode reachable in production, an
endpoint present but absent from the declared interface. Do not decline this class merely
because the file is not named like a configuration file.
```

### vulnerable-components.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the dependency is current and the defect is in how this codebase calls it — use the
  class matching that defect
- the dependency is current and an option passed to it is unsafe — that is
  misconfiguration
- the concern is that the dependency was fetched or updated without verification — that
  is integrity-failures

Choose vulnerable-components when the defect is the version of third-party code present,
and the remedy is to upgrade, replace, or remove that dependency rather than to change
this codebase's own logic.
```

### integrity-failures.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the data is verified and the defect is that its content is parsed as executable
  structure — that is injection
- the verification is present but the key or signature protecting it is weak — that is
  crypto-auth
- verification is disabled by an option rather than absent from the code — that is
  misconfiguration
- the payload is verified and the harm is the volume of work it triggers — that is
  resource-consumption

Choose integrity-failures when data, code, or an update is consumed without verifying it
has not been tampered with in transit or at rest — unsigned payloads, unverified
deserialization, unauthenticated update or plugin channels.
```

### logging-monitoring.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the logging is adequate and the underlying operation is itself unauthorized — use the
  class matching that operation
- a log level or destination is set to an unsafe value — that is misconfiguration
- the logged value is a secret that is also weak or reused — that is crypto-auth

Choose logging-monitoring when a security-relevant event is not recorded, is recorded
without enough detail to reconstruct it, or is recorded with data that should never be
written down. The gap is in the record of the event, not in the event.
```

### ssrf.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the caller influences a value inside the request body or query rather than the
  destination it is sent to — that is injection
- the destination is fixed and the response is trusted without validation — that is
  integrity-failures
- the destination is fixed and the defect is how many requests can be triggered — that is
  resource-consumption
- the fetch is authorized but returns a resource belonging to another user — that is
  access-control

Choose ssrf when the server issues an outbound request — over any protocol, to a URL, a
host, or a filesystem path — to a destination the caller can influence. Never fall back to
general-catchall for this shape.
```

### api-property-auth.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the caller reaches a record that is not theirs at all — that is access-control;
  api-property-auth means the record is legitimately theirs and the field set is wrong
- the field value is interpreted as query or code structure rather than stored — that is
  injection
- no field-level boundary was ever designed for this model — that is insecure-design
- the exposed field is a credential or key that is also weakly protected — that is
  crypto-auth

Choose api-property-auth when the object is the right object but the properties crossing
the boundary are wrong: a caller writing a field they should not control, or reading a
field they should not see.
```

### resource-consumption.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the request is cheap and the defect is that it reaches data belonging to someone else —
  that is access-control
- the input alters how a query or interpreter parses — that is injection
- a limit exists in code but is configured to an ineffective value — that is
  misconfiguration
- the operation is bounded per request and the abuse is repeating a legitimate flow to
  extract value — that is sensitive-business-flows

Choose resource-consumption when a single caller-triggered operation performs work — CPU,
memory, storage, connections, third-party spend — that is not bounded by the code, so cost
scales with what the caller asks for.
```

### sensitive-business-flows.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the flow can be reached by a caller who should not reach it at all — that is
  access-control
- the flow is sound and the cost of one invocation is unbounded — that is
  resource-consumption
- the flow's own logic permits the abuse in a single pass, without repetition — that is
  insecure-design

Choose sensitive-business-flows when each individual invocation is legitimate and
authorized, and the harm comes from automating or repeating it at a scale the business
logic assumed a human would not reach.
```

### general-catchall.ts

```
## Distinguishing From Adjacent Classes
This is the class of last resort. Before choosing it, confirm the finding matches none of
the specific classes — in particular:
- an outbound request to a caller-influenced destination is ssrf, never this class
- an unsafe option, default, or exposed surface is misconfiguration
- an unverified payload or update channel is integrity-failures
- a response consumed without schema validation, where the destination is fixed and the
  trust is misplaced, is integrity-failures

Choose general-catchall only when the defect is genuinely real and traceable but fits no
other class in the assigned set. Preferring it over a specific class that applies is a
labelling error, not caution.
```

### client-side.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the sink executes on the server rather than in the browser — that is injection
- the rendered content originates from a model's output and the concern is what that
  model was induced to emit — that is ai-llm-agency
- the framework's protections are intact and a build or policy option disabled them —
  that is misconfiguration
- the browser correctly renders data the caller was never entitled to receive — that is
  access-control

Choose client-side when the sink executes in the user's browser and attacker-influenced
content reaches it through an escape hatch, an unsafe rendering path, or a disabled
sanitizer.
```

### ai-llm-agency.ts

```
## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the model's output reaches a server-side interpreter that parses it as query or code —
  that is injection
- the tool re-derives the caller's authority correctly and the underlying handler still
  returns another user's record — that is access-control
- the model's output is rendered unsafely in the browser — that is client-side
- the loop is bounded and the defect is a missing per-request cost or turn limit — that
  is resource-consumption

Choose ai-llm-agency when untrusted content reaches the instruction channel, or when a
tool or handler acts on the model's output with authority the requesting user does not
independently hold.
```

---

## Report back

- The diff.
- For each of the 15 files: the section heading immediately before and after the inserted
  block, proving placement.
- Confirmation that `tools/scanner/stage2-hunt-lanes/src/playbooks/` is unchanged.
- The type-check / build result for `stage2-hunt-lanes-perfile`.
- The byte size of each playbook before and after.
- Anything you find that contradicts this brief.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or
reference any answer-key or ground-truth material anywhere on this machine.

export const playbook = `
Playbook for Client-Side XSS / Improper Output Handling (LLM05)
===============================================================

Scope: Detect client-side cross-site scripting where unsanitized dynamic content reaches DOM execution sinks.

## OWASP Categories Covered
- OWASP LLM05: Improper Output Handling (client-side XSS variant)

## Sink Patterns to Hunt For
1. Framework-level security bypass functions: explicit calls that disable the framework's built-in output sanitization (e.g., "trust this HTML as safe" APIs that short-circuit auto-escaping).
2. Raw DOM manipulation: direct assignment to properties that insert HTML into the DOM (innerHTML, outerHTML), or methods that write raw HTML to the document, when the content is derived from user-influenced data.
3. Server-rendered HTML injection: HTML rendering functions that accept user-provided template content rather than rendering static templates, where the template language supports embedded code execution.
4. HTML sanitization libraries with disabled or weakened configuration: sanitization calls with skip/allowlist-all settings, or sanitization not applied before HTML-inserting operations.
5. Dynamic code evaluation in the browser: eval() on DOM content or dynamically constructed script strings.
6. Template rendering with user-controlled content that is inserted into script contexts or event handler attributes (where HTML sanitization does not provide protection).

## Source Patterns: any dynamic content from API responses, URL parameters, route parameters, or user-submitted input reaching the above sinks.

## Distinguishing Real Findings from False Positives
- Using a security bypass is not inherently vulnerable. Reaching it with attacker-controllable content that has not been sanitized is.
- Framework-level auto-sanitization (default binding, auto-escaping) is safe — the finding requires an explicit bypass.
- Content that is purely server-generated with no user influence path is not a finding.
- Sanitization must be context-appropriate: HTML sanitization does not protect against script context injection (e.g., inserting into a script tag or event handler attribute).

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The entrypoint (source of user-controlled data)
2. The data-flow path through the application to the client
3. The DOM sink (HTML insertion, security bypass, dynamic eval)
4. Confirm no sanitization layer exists between the source and the sink
5. The XSS payload class that would execute in this context.
`

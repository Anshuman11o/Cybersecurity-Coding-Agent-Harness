export const playbook = `
Playbook for Client-Side XSS / Improper Output Handling (LLM05)
===============================================================

Scope: Detect client-side cross-site scripting where unsanitized dynamic content reaches DOM execution sinks.

## OWASP Categories Covered
- OWASP LLM05: Improper Output Handling (client-side XSS variant)

## Sink Patterns to Hunt For
1. Angular: bypassSecurityTrustHtml() calls, bypassSecurityTrustScript(), bypassSecurityTrustResourceUrl() — these are explicit escape hatches that disable Angular's built-in sanitization.
2. Raw DOM manipulation: element.innerHTML assignment, element.outerHTML, document.write(), document.writeln() with dynamic content.
3. React: dangerouslySetInnerHTML with unsanitized content — the prop name itself signals the risk.
4. DOMPurify: DOMPurify.sanitize() with skip: true or equivalent configuration that disables sanitization, or DOMPurify not applied before innerHTML assignment.
5. eval() on DOM content or dynamically constructed JavaScript strings.
6. Template rendering with user-controlled content that is inserted into script contexts or event handlers.

## Source Patterns: any dynamic content from API responses, URL parameters, route parameters, or user-submitted input reaching the above sinks.

## Distinguishing Real Findings from False Positives
- Using an escape hatch is not inherently vulnerable. Reaching it with attacker-controllable content that has not been sanitized is.
- Framework-level auto-sanitization (Angular's default binding, React's JSX) is safe — the finding requires an explicit bypass.
- Content that is purely server-generated with no user influence path is not a finding.
- Sanitization must be context-appropriate: HTML sanitization does not protect against JavaScript context injection (e.g., inserting into a script tag or event handler).

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (source of user-controlled data)
2. The data-flow path through the application to the client
3. The DOM sink (innerHTML, bypassSecurityTrustHtml, etc.)
4. Confirm no sanitization layer exists between the source and the sink
5. The XSS payload class that would execute in this context.
`;

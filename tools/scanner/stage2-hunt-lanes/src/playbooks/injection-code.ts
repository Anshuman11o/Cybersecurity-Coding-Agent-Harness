export const playbook = `
Playbook for Code Execution and SSTI Injection (OWASP A03)
==========================================================

Scope: Detect injection vectors that lead to arbitrary code execution or server-side template injection.

## OWASP Categories Covered
- OWASP A03: Injection (Code Execution / SSTI variant)

## Sink Patterns to Hunt For
1. eval(): JavaScript eval() with any user-controlled input in the evaluated string. Also: new Function() constructor, setTimeout/setInterval with string arguments (implicit eval).
2. child_process: exec(), execSync(), execFile() where the command string or arguments include user-controlled input. Also: spawn() with shell: true and user-controlled arguments.
3. Template engines: pug, ejs, handlebars, nunjucks, or similar rendering user-controlled template content. SSTI occurs when the template language supports code execution (e.g., pug allows arbitrary JS, ejs allows <% %> blocks).
4. Dynamic import/require: require(req.body.module), import(userPath) — loading and executing arbitrary server-side modules.
5. vm module: vm.runInContext(), vm.runInNewContext() with user-provided source — even "sandboxed" VM contexts can escape.

## Distinguishing Real Findings from False Positives
- Using eval/Function internally with fully hardcoded strings is a code smell but not exploitable — the finding requires a path from user input to code execution.
- child_process.spawn() with a fixed command and user-supplied arguments array (not shell: true) is safer because arguments are not interpreted by a shell. But argument injection (e.g., passing --flag value as an argument) is still a risk.
- Template rendering of static template files is safe; rendering user-provided template strings is SSTI.
- vm module "sandboxes" are not security boundaries in Node.js — code can escape via constructor access.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route + HTTP method)
2. The tainted input source
3. The data-flow path showing how user input reaches the execution sink
4. The execution call (eval, exec, template render, etc.)
5. A proof-of-concept payload that demonstrates code execution.
`;

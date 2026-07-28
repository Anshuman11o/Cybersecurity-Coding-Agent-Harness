export const playbook = `
Playbook for AI/LLM Security Issues (OWASP LLM01-LLM10)
=======================================================

Scope: Detect prompt injection, sensitive disclosure, excessive agency, and consumption issues in LLM-integrated applications.

## OWASP Categories Covered
- OWASP LLM01: Prompt Injection
- OWASP LLM02: Sensitive Information Disclosure
- OWASP LLM03: Supply Chain
- OWASP LLM06: Excessive Agency
- OWASP LLM10: Unbounded Consumption

## Sink Patterns to Hunt For
1. System prompts built by concatenating user-provided content without proper fencing/separation from the system instructions. The user content should be delimited or escaped so the model cannot interpret it as instructions.
2. Tool handlers that execute privileged actions (send messages, modify data, make purchases, call APIs) based solely on model decisions without independently verifying the user's authorization for that specific action.
3. Tool return values containing sensitive data (internal system state, other users' data, credentials, PII) passed back to the user or into the model context without filtering or redaction.
4. Unbounded tool-calling loops: the model can call tools repeatedly without step/turn caps, enabling excessive token consumption, runaway API calls, or resource exhaustion.
5. Training data or fine-tuning pipelines that incorporate unfiltered user input, enabling data poisoning or sensitive data leakage in model outputs.

## Distinguishing Real Findings from False Positives
- "The model could be tricked" is not a finding. The finding must name the specific boundary crossed and the capability an attacker gains beyond what the human user already has.
- A tool call that the user could perform manually through the interface is not excessive agency. A tool call that performs an action the user cannot normally do (e.g., accessing another user's data, executing admin operations) is.
- System prompt injection is a finding when the injected content causes the model to perform an action the application did not intend — not merely when the model's output changes.
- Sensitive data in tool returns is a finding only when that data reaches the user or an untrusted context.

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

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The model integration point (chat, tool handler, agent loop)
2. The injection vector or agency boundary
3. The specific unintended action or data exposure
4. The attacker's gained capability beyond normal user permissions.
`

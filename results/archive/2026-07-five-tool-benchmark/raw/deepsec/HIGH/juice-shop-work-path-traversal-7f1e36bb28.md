# [HIGH] XXE with external entity resolution and host filesystem access

**File:** `lib/xml.ts` (lines 21, 22, 35)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `path-traversal`

## Finding

parseXmlString() (L33-42) parses user-supplied XML with XML_PARSE_NOENT | XML_PARSE_DTDLOAD (entity substitution + DTD loading) enabled, and explicitly registers filesystem input providers (xmlRegisterFsInputProviders, L21-22) so external entities like `file:///etc/passwd` resolve. This is a classic XXE allowing local file disclosure and potential SSRF via external entities. The `new Function()` at L12 flagged by the scanner is only a dynamic-import shim (static string, not user input) and is NOT an RCE; the vm timeout mitigates billion-laughs DoS but not file exfiltration. Note: this is intentionally vulnerable training code for the XXE challenges, but the exposure is real.

## Recommendation

For any non-training deployment, disable DTD/entity loading (do not set NOENT/DTDLOAD) and do not register filesystem input providers. Reject DOCTYPE declarations in untrusted XML.

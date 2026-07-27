# [MEDIUM] Automatic rebase triggerable by any commenter without authorization check

**File:** `.github/workflows/rebase.yml` (lines 4, 10, 13)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `missing-auth`

## Finding

The workflow fires on `issue_comment` (created) whenever a comment on a PR contains the substring '/rebase' (github.event.issue.pull_request != '' && contains(comment.body, '/rebase')). There is no check on github.event.comment.author_association or the commenter's push permission, so any GitHub user — including a non-collaborator with no write access — can post a '/rebase' comment on an open PR and cause the runner to checkout (fetch-depth: 0) and rebase/force-push the PR branch using GITHUB_TOKEN. The substring match is also loose ('/rebase' anywhere in the body). This enables abuse: unsolicited force-pushes onto contributors' PR branches, potential clobbering of PR history, and repeated triggering as a resource/DoS vector. The cirrus-actions/rebase action performs git operations only (not building untrusted code), which limits impact, and any internal permission check in the action is the only thing standing between an anonymous commenter and the action — the workflow itself enforces nothing.

## Recommendation

Gate the job on commenter authorization, e.g. `if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)` and/or verify push permission via the API before running. Match the command precisely (e.g. comment body trimmed equals '/rebase') rather than a substring, and set an explicit least-privilege `permissions:` block.

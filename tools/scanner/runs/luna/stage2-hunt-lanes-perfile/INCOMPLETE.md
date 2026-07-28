# INCOMPLETE RUN — do not score these artifacts as-is

Stage 2 exited 0 and `meta.json` records `exit_code: 0, degraded: false`, but
**52 of 541 hunt lanes never ran**. Every failure is an OpenAI tokens-per-minute
rate limit on `gpt-5.6-luna`, hit after the executor's 3 retries were exhausted
(398 further retries did succeed). No guard blocks, no schema fallbacks — this is
infrastructure, not model behaviour.

`candidate-findings.json` therefore covers 489 lanes, not 541. Any recall figure
computed from it is depressed by the missing lanes and must not be reported as a
reasoning result.

Two defects made this survivable-looking:

1. The failure handler writes a consumption entry for a failed lane, and
   `loadCheckpoint` derives `completedLaneIds` from those entries — so a resume
   would skip all 52 permanently and report success.
2. The completion write replaces the checkpoint array with the v2 object, and
   `loadCheckpoint` requires an array — so after any finished run, resume is a
   no-op and a re-run costs full price.

## The 52 lanes that did not run

| lane | target file |
|---|---|
| `file-0055` | `frontend/src/app/Services/local-backup.service.spec.ts` |
| `file-0056` | `frontend/src/app/Services/local-backup.service.ts` |
| `file-0060` | `frontend/src/app/Services/payment.service.ts` |
| `file-0069` | `frontend/src/app/Services/recycle.service.spec.ts` |
| `file-0072` | `frontend/src/app/Services/security-answer.service.spec.ts` |
| `file-0094` | `frontend/src/app/accounting/accounting.component.spec.ts` |
| `file-0096` | `frontend/src/app/address-create/address-create.component.spec.ts` |
| `file-0103` | `frontend/src/app/administration/administration.component.ts` |
| `file-0112` | `frontend/src/app/challenge-solved-notification/challenge-solved-notification.component.ts` |
| `file-0117` | `frontend/src/app/chatbot/chat-conversation/chat-conversation.component.spec.ts` |
| `file-0118` | `frontend/src/app/chatbot/chat-conversation/chat-conversation.component.ts` |
| `file-0131` | `frontend/src/app/coding-challenge-page/components/coding-challenge-find-it/coding-challenge-find-it.component.ts` |
| `file-0142` | `frontend/src/app/contact/contact.component.spec.ts` |
| `file-0154` | `frontend/src/app/faucet/faucet.component.ts` |
| `file-0162` | `frontend/src/app/login/login.component.spec.ts` |
| `file-0167` | `frontend/src/app/navbar/navbar.component.spec.ts` |
| `file-0168` | `frontend/src/app/navbar/navbar.component.ts` |
| `file-0186` | `frontend/src/app/payment/payment.component.ts` |
| `file-0188` | `frontend/src/app/photo-wall/photo-wall.component.spec.ts` |
| `file-0195` | `frontend/src/app/product-details/product-details.component.ts` |
| `file-0199` | `frontend/src/app/product/product.component.ts` |
| `file-0206` | `frontend/src/app/register/register.component.spec.ts` |
| `file-0207` | `frontend/src/app/register/register.component.ts` |
| `file-0213` | `frontend/src/app/score-board/components/challenge-card/challenge-card.component.spec.ts` |
| `file-0216` | `frontend/src/app/score-board/components/challenges-unavailable-warning/challenges-unavailable-warning.component.ts` |
| `file-0227` | `frontend/src/app/score-board/components/filter-settings/filter-settings.component.ts` |
| `file-0247` | `frontend/src/app/search-result/search-result.component.spec.ts` |
| `file-0254` | `frontend/src/app/sidenav/sidenav.component.spec.ts` |
| `file-0270` | `frontend/src/app/web3-sandbox/web3-sandbox.component.ts` |
| `file-0272` | `frontend/src/app/welcome-banner/welcome-banner.component.spec.ts` |
| `file-0276` | `frontend/src/assets/public/ContractABIs.ts` |
| `file-0294` | `frontend/src/hacking-instructor/helpers/helpers.ts` |
| `file-0306` | `lib/insecurity.ts` |
| `file-0321` | `lib/startup/validatePreconditions.ts` |
| `file-0327` | `models/basketitem.ts` |
| `file-0348` | `routes/2fa.ts` |
| `file-0374` | `routes/languages.ts` |
| `file-0379` | `routes/metrics.ts` |
| `file-0401` | `routes/userProfile.ts` |
| `file-0403` | `routes/videoHandler.ts` |
| `file-0418` | `test/api/chat.test.ts` |
| `file-0422` | `test/api/data-export.test.ts` |
| `file-0426` | `test/api/feedback.test.ts` |
| `file-0441` | `test/api/password.test.ts` |
| `file-0446` | `test/api/profile-image-upload.test.ts` |
| `file-0448` | `test/api/quantity.test.ts` |
| `file-0456` | `test/api/socket.test.ts` |
| `file-0460` | `test/api/user.test.ts` |
| `file-0465` | `test/cypress/e2e/basket.spec.ts` |
| `file-0505` | `test/server/challengeUtils.unit.test.ts` |
| `file-0508` | `test/server/configValidation.unit.test.ts` |
| `file-0521` | `test/server/preconditionValidation.unit.test.ts` |

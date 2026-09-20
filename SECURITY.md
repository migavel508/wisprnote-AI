# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately to **hello@wisprbee.com**. Include:

- What the issue is and roughly how severe you think it is
- Steps to reproduce, or a proof of concept
- Affected version or commit, and your platform
- Whether you would like to be credited in the fix announcement

We aim to acknowledge reports within 3 business days and to keep you updated as we
investigate. Please give us a reasonable opportunity to ship a fix before disclosing
publicly.

## Scope

In scope: the Wisprnote desktop application, the Rust audio capture helpers, the MCP
server, and the backend handlers under `aws/api/`.

Out of scope: vulnerabilities in third-party dependencies (report those upstream, though
we appreciate a heads-up), and findings that require an attacker to already have
administrative access to the user's machine.

## Handling your own deployment safely

Wisprnote processes meeting audio and transcripts — some of the most sensitive data an
organisation has. If you self-host:

- **Never commit secrets.** `.env*` is gitignored except `.env.example`. Keep it that way.
  Every credential in `.env.example` is a placeholder; real values belong in your local
  `.env.local` or your platform's secret store.
- **Rotate any key that has ever been pasted into a chat, issue, screenshot, or log.**
  Assume it is compromised.
- **Scope your AWS credentials.** The backend needs only the resources it actually uses;
  do not deploy it with an administrator access key.
- **Consent matters, and is often a legal requirement.** Wisprnote transcribes everything
  said in a meeting. Recording laws vary by jurisdiction and several require all-party
  consent. Tell participants they are being recorded.
- **Third-party processors.** In its default configuration, audio and text are sent to
  external AI providers (transcription, LLM, embedding, vector search). Review each
  provider's data-handling terms before processing confidential material, and see
  `docs/INSTALL.md` for which providers are involved and which are optional.

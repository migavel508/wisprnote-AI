# Contributing to Wisprnote

Thanks for your interest. Bug reports, fixes, and features are all welcome.

## Before you start: the CLA

Wisprnote is dual-licensed — AGPL-3.0 for everyone, plus a commercial licence for
users who cannot comply with the AGPL (see [LICENSING.md](LICENSING.md)). Offering
both is only lawful if the project holds sufficient rights in **every** line of code
it ships.

So we ask contributors to agree to a **Contributor Licence Agreement**. By opening a
pull request, you confirm that:

1. You wrote the contribution, or you have the right to submit it.
2. You grant the copyright holder a perpetual, worldwide, irrevocable, royalty-free
   licence to use, reproduce, modify, and distribute your contribution, **including
   the right to license it under both the AGPL-3.0 and our commercial licence**.
3. You retain your own copyright. You are licensing your work to us, not signing it away.
4. If you contribute on behalf of an employer, you have the authority to do so.

If you cannot agree to point 2, please still open an **issue** — a clear bug report is
genuinely valuable, and we would rather have it than nothing.

We may ask you to confirm this explicitly on your first PR.

## Setting up

See **[docs/INSTALL.md](docs/INSTALL.md)** for the full environment setup. Short version:

```bash
npm install
cp .env.example .env.local   # then fill in your own keys
npm run tauri:dev
```

## Before you open a PR

```bash
npm run lint     # tsc --noEmit — must pass
npm run test     # vitest
```

For Rust changes, also:

```bash
cargo fmt --check && cargo clippy    # in src-tauri/ and record_system_audio/
```

## House style

- **Match the code around you.** Naming, comment density, and structure vary between
  the TypeScript app, the Rust helpers, and the Lambda handlers. Follow the local idiom
  rather than imposing a global one.
- **Comments explain *why*, not *what*.** The existing codebase is fairly heavily
  commented where behaviour is subtle (OAuth redirects, audio capture, plan gating) —
  keep that up, and skip narrating the obvious.
- **No new dependency without a reason.** Say what it buys us in the PR description.
- **Keep commits focused.** One logical change per commit; a readable history matters
  more than a tidy one.

## Never commit

- Real credentials. `.env*` is gitignored except `.env.example` — keep every value in
  that file a placeholder.
- Real meeting audio, transcripts, or customer data, including in test fixtures. Use
  synthetic data.
- Anything identifying a specific deployment: AWS account IDs, live API Gateway URLs,
  Cognito pool IDs, role ARNs. These belong in environment variables.

A `git grep` for your own email address before pushing is a cheap habit.

## Reporting bugs

Open an issue with: what you expected, what happened, your platform and version, and
steps to reproduce. Redact any real meeting content from logs you paste.

**Security issues do not go in public issues** — see [SECURITY.md](SECURITY.md).

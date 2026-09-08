# Contributing

Contributions that improve browser profile isolation, test automation, reliability, accessibility, documentation or defensive security are welcome.

This project is intended for websites and accounts you own or are authorized to test. Contributions whose primary purpose is bypassing access controls, challenges, rate limits or third-party account restrictions will not be accepted.

## Development

Use Node.js 20 or newer, then run:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Real browser checks are opt-in because they require the managed browser binaries:

```sh
npm run install:browsers
npm run test:fingerprint-runtime
```

Keep runtime profiles, cookies, credentials, screenshots, browser binaries and signing material outside Git. The repository `.gitignore` excludes the standard local locations, but contributors remain responsible for reviewing every staged file before committing.

## Main branch and pull requests

After the initial hosted CI and unsigned-package verification, `main` is protected.
Create a branch and open a pull request; do not push directly or force-push to `main`.
Before merging, update the branch to the current `main`, resolve all review conversations,
and wait for the required `verify`, `firefox`, and `windows` checks to pass.
The solo-maintainer policy requires a pull request but zero approving reviews.
CodeQL results still require security triage; they are not an initial required-check lockout.

Windows CI explicitly runs both `test:firefox` and `test:fingerprint-runtime` in addition
to the normal integration suite. Skipped opt-in cases and Firefox Worker Canvas
`NOT PASSED` diagnostics are not production acceptance. Playwright and custom-core
updates require manual runtime compatibility review; Dependabot PRs are not auto-merged.

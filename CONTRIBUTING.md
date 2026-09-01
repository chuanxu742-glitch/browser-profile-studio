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

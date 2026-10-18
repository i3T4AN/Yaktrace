# sidechat.js

[![NPM Version](https://img.shields.io/npm/v/sidechat.js)](https://www.npmjs.com/package/sidechat.js?activeTab=versions)
[![GitHub last commit](https://img.shields.io/github/last-commit/micahlt/sidechat.js)](https://github.com/micahlt/sidechat.js)
[![NPM License](https://img.shields.io/npm/l/sidechat.js)]()
[![NPM Downloads](https://img.shields.io/npm/dt/sidechat.js?label=downloads)](https://npmjs.com/package/sidechat.js)
[![npm bundle size](https://img.shields.io/bundlephobia/min/sidechat.js)](https://www.npmjs.com/package/sidechat.js?activeTab=code)


A reverse-engineered API wrapper for [Sidechat/YikYak](https://sidechat.lol) in Node.  Easy to use, documented with JSDoc, and kept up to date as much as possible.  Designed for [Offsides](https://github.com/micahlt/offsides), a third-party Sidechat client for Android devices.  Documentation can be found [here](https://micahlindley.com/sidechat.js).

## Getting Started

> Note: sidechat.js uses the Fetch API released in Node.js 18.  If you're attempting to use it in a lower version of Node you will have to polyfill the fetch requests yourself.

Install sidechat.js with your preferred package manager:

```bash
$ npm install sidechat.js
```

Next, take a look at the [authentication tutorial](https://micahlindley.com/sidechat.js/tutorial-Authentication.html) to find out how to log your client in and begin making requests.

## Local fixed-window capture

The repository includes a local-only CLI for the authorized analytics workflow. It uses Node's built-in SQLite support—no dashboard, service, container, or deployment is involved.

Use Node 22.13 or newer, install dependencies, then run:

```bash
npm install
npm run analytics -- capture
```

The command prompts for the account's SMS login only when no saved local session exists. Immediately after authentication it replaces prior local captures for the selected school, locks a UTC window from that moment back three calendar months, collects in-window posts, blocks the source of the newest available non-self post, and repeats that same-window collection until no blockable posts remain. It then unhides all blocked sources and stores one final same-window capture containing only posts authored by the program account. It persists every capture:

- normalized posts with their metadata;
- immutable raw post-page API response JSON; and
- snapshot timestamps, cursors, and collection counts.

The command defaults to the authenticated account's primary school membership. You may override that with `--group GROUP_ID`; use `npm run analytics -- groups` to print the memberships returned by the source API. The database is local at `data/yikstein.sqlite`, excluded from Git, and its file permissions are set to owner-only. Use `npm run analytics -- login` to authenticate without starting a collection, or append `--relogin` to force a new SMS login.

Every `capture` command is one fresh end-to-end run. Post-page retrieval uses one global limit of ten requests per second. If the service returns a rate-limit response, the collector uses exponential cooldown and keeps the same snapshot window and cursor. You may tune the global limit with `YIKSTEIN_REQUESTS_PER_SECOND`, but increasing it can cause more throttling.

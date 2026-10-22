# How to Use YakTrace

YakTrace is a local CLI. Run it only with permission to access the account, group, and resulting data.

## Install

From the repository root:

```bash
cd YakTrace
npm install
npm run yaktrace -- help
```

Node.js 22.13 or later is required because YakTrace uses Node's built-in SQLite module.

## Commands

Authenticate without collecting:

```bash
npm run yaktrace -- login
```

List the authenticated account's available school groups:

```bash
npm run yaktrace -- groups
```

Start a new fixed-window capture using the account's first returned group. YakTrace opens an up/down-arrow selector at 1 week; increase it to any value through 15 weeks, then press Enter:

```bash
npm run yaktrace -- capture
```

Target a specific group or force a new SMS login:

```bash
npm run yaktrace -- capture --group GROUP_ID --relogin
```

For a non-interactive capture—or to skip the selector—pass the desired number of most-recent weeks explicitly:

```bash
npm run yaktrace -- capture --weeks 6
```

## What a capture does

The command locks the selected most-recent 1-15-week UTC window, captures the available in-window posts, and performs its configured comparison workflow over that same window. Before it finishes, it reverses its temporary source-hiding changes and stores a final capture limited to posts authored by the logged-in account. It then produces a PDF dossier.

The command may take a long time for active groups. It paces requests and retries rate-limited responses with backoff; do not run concurrent captures against the same account or group.

## Runtime files

By default, private working data is written beneath `YakTrace/.runtime/`:

- `yaktrace.sqlite` contains the local session token, capture state, and collected data.
- `reports/` contains generated PDF dossiers.

The directory is ignored by Git and is intentionally absent from a fresh release. Back up or remove it yourself according to your data-retention obligations. You can place the database elsewhere with `--database path/to/file.sqlite`.

## Troubleshooting

- **Node reports that SQLite is unavailable:** upgrade to Node 22.13 or newer.
- **No school memberships are returned:** finish account registration in the source application, then retry with `--relogin`.
- **Rate limits:** allow YakTrace's retry delay to complete; lowering `YIKSTEIN_REQUESTS_PER_SECOND` below its default of 10 can reduce throttling.
- **Interrupted capture:** rerun the same command with the same database path. The CLI records incomplete snapshots so the capture can resume where possible.

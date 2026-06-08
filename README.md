# Morning Briefing for an Indian Stock Portfolio

A small, **self-hosted-on-GitHub** service that, once a day before the Indian
market opens:

1. Reads your portfolio from [`portfolio.json`](./portfolio.json).
2. For each holding, fetches the latest price (Yahoo Finance) plus current news,
   and asks Claude for a short, honest read.
3. Evaluates how the **previous run's** calls turned out and updates a running
   track record.
4. Sends you the whole briefing on **Telegram**.
5. Commits the updated history back to the repo so the record persists.

There is **no separate server** — it runs entirely on a [GitHub Actions cron
job](.github/workflows/briefing.yml). TypeScript on Node 20.

---

## ⚠️ Honest by design — please read this

This project is deliberately built to be honest about what it is and is not.

- **This is information, not financial advice.** This line is in both the
  Telegram message and this README on purpose. Do your own research; consider a
  registered adviser before acting.
- **Calls are not reliable.** Short-term (roughly one-trading-day) direction is
  close to a coin flip. The track record exists precisely to show that honestly —
  expect a hit rate near ~50%, which is what a coin flip gives.
- **"Learning from mistakes" means only one thing here:** recent past calls and
  their outcomes are fed back into the prompt as plain text *context*, so the
  model can see its own record. **That is it.** The model is **not** retrained,
  fine-tuned, or improved between runs. There is **no self-training** of any kind
  in this project, and none is claimed. (See the comments in
  [`src/claude.ts`](./src/claude.ts) and [`src/evaluate.ts`](./src/evaluate.ts).)

### How the track record is scored (and its simplifications)

- At the start of each run, the most recent unresolved calls are evaluated by
  comparing the **price stored when the call was made** to the **current price**.
- This is a **rough ~1-trading-day horizon**: it simply uses "the price at the
  next run". It does not align to exact market sessions, ignores intraday moves,
  dividends, and splits, and a missed/delayed run lengthens the horizon. It is a
  blunt, honest proxy — not a backtest.
- **Only directional calls are scored:**
  - `Add` is **right** if the price **rose**.
  - `Trim` / `Avoid` are **right** if the price **fell**.
  - `Hold` / `Watch` are **not scored** (excluded from the hit rate).
  - An exactly-flat price is treated as **unscored**.
- The running hit rate shown is `right / (right + wrong)` over all scored calls.

---

## How it works

| File | Responsibility |
| --- | --- |
| [`src/prices.ts`](./src/prices.ts) | Yahoo Finance price lookups (`.NS` / `.BO`). Unofficial source — each lookup is wrapped in try/catch. |
| [`src/claude.ts`](./src/claude.ts) | Anthropic Messages API client with the `web_search` tool; per-holding analysis + research ideas; robust JSON parsing. |
| [`src/evaluate.ts`](./src/evaluate.ts) | Track-record evaluation and hit-rate maths. |
| [`src/telegram.ts`](./src/telegram.ts) | Telegram delivery + message splitting. |
| [`src/index.ts`](./src/index.ts) | Orchestrator that ties it all together. |
| [`src/types.ts`](./src/types.ts) | Shared types. |
| [`portfolio.json`](./portfolio.json) | Your holdings (edit this). |
| [`data/history.json`](./data/history.json) | The persisted track record (committed by the workflow). |

For each holding the model is asked to return **only** minified JSON:

```json
{"stance":"Add|Hold|Trim|Watch|Avoid","confidence":"Low|Medium|High","reasoning":"at most 3 short plain sentences","keyNews":["short headline"]}
```

Parsing is defensive: code fences are stripped, the first `{...}` object is
extracted, and any failure falls back to an honest "analysis unavailable" note
rather than crashing.

---

## Setup

### 1. Create a Telegram bot and get your chat id

1. In Telegram, message **[@BotFather](https://t.me/BotFather)**, send
   `/newbot`, and follow the prompts. It gives you a **bot token** that looks
   like `123456789:ABCdef...`. That is your `TELEGRAM_BOT_TOKEN`.
2. **Start a chat with your new bot** and send it any message (a bot can't
   message you until you've talked to it first).
3. Find your **chat id**:
   - Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in a browser
     (replace `<YOUR_BOT_TOKEN>`).
   - Look for `"chat":{"id":<number>,...}`. That number is your
     `TELEGRAM_CHAT_ID`.
   - (Alternative: message **@userinfobot**, which replies with your id.)

### 2. Add the three GitHub secrets

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add:

| Secret | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (`sk-ant-...`). |
| `TELEGRAM_BOT_TOKEN` | The bot token from @BotFather. |
| `TELEGRAM_CHAT_ID` | Your chat id. |

(Optional) Under the **Variables** tab you can add a repository variable
`MODEL` to override the Claude model — it defaults to `claude-sonnet-4-6`.

### 3. Edit your portfolio

Edit [`portfolio.json`](./portfolio.json) directly on GitHub. It's an array of:

```json
{ "symbol": "RELIANCE", "name": "Reliance Industries", "exchange": "NS", "qty": 10, "buyPrice": 2750.0 }
```

- `symbol` — the base ticker **without** a suffix.
- `exchange` — `"NS"` for NSE (`.NS`) or `"BO"` for BSE (`.BO`).
- `qty`, `buyPrice` — your position; used for the profit/loss line.

---

## Testing it

### Via GitHub (recommended first test)

Go to **Actions → Morning Briefing → Run workflow** (`workflow_dispatch`). This
runs the whole pipeline on demand and sends you a real Telegram message. Check
the run logs if anything looks off.

### Locally

```bash
npm install
cp .env.example .env      # then fill in your real values
npm run briefing
```

`npm run briefing` reads the same env vars from `.env` via `dotenv`. The real
`.env` is gitignored. If the Telegram secrets are missing, the briefing is
printed to your terminal instead of sent, so you can preview formatting.

You can also type-check without running anything:

```bash
npm run typecheck
```

---

## Changing the schedule

Edit the `cron` line in
[`.github/workflows/briefing.yml`](.github/workflows/briefing.yml):

```yaml
on:
  schedule:
    - cron: "0 3 * * *"   # 03:00 UTC = 08:30 IST
```

Cron is in **UTC** (5 hours 30 minutes behind IST). For example, `30 2 * * *`
is 08:00 IST. Note that **GitHub's cron is best-effort and can be delayed**, and
**scheduled workflows are paused after ~60 days of repo inactivity** — push a
commit or re-enable the workflow to resume.

---

## Secrets used (summary)

| Name | Where | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | GitHub secret / `.env` | Calls the Claude Messages API. |
| `TELEGRAM_BOT_TOKEN` | GitHub secret / `.env` | Sends the Telegram message. |
| `TELEGRAM_CHAT_ID` | GitHub secret / `.env` | Where the message goes. |
| `MODEL` | GitHub variable / `.env` | Optional model override (default `claude-sonnet-4-6`). |

The workflow commits `data/history.json` using the built-in `GITHUB_TOKEN`
(`permissions: contents: write`), committing as `github-actions[bot]`.

---

## Push this to a new GitHub repo

If you're starting from these files locally:

```bash
git init
git add .
git commit -m "Initial commit: honest morning briefing service"
git branch -M main

# Create an empty repo on GitHub first (no README/license), then:
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Then add the three secrets (above) and run the workflow manually to test.

---

## License

MIT — see this repo. Use at your own risk; again, **this is information, not
financial advice.**

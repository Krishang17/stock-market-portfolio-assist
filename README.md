# Portfolio Briefing — an honest, self-hosted stock dashboard

A small service that, once a day, looks at your Indian stock portfolio and
publishes a **dashboard** (hosted free on GitHub Pages) showing, for each
holding:

- the latest price and your profit/loss,
- a short, honest **buy-more / hold / trim / sell** read from Claude,
- the **news and source links** behind that read,
- a few **new stock ideas** to research, and
- a running, **benchmark-relative track record** of how past calls did.

It runs entirely on GitHub — a [GitHub Actions cron](.github/workflows/briefing.yml)
generates the data, commits it, and GitHub Pages serves the dashboard. **No
server, no Telegram.** TypeScript on Node 22.

---

## ⚠️ Honest by design — please read this

- **This is information, not financial advice.** That line is on the dashboard
  and here on purpose. Do your own research; consider a registered adviser.
- **Calls are not reliable.** Short-term (~one-trading-day) direction is close to
  a coin flip. The track record exists to show that honestly — expect a hit rate
  near ~50%.
- **Everything is backed by sources.** Each read is produced by Claude using live
  web search, and the source links it consulted are shown under each card. Prices
  come from Yahoo Finance (an unofficial source).
- **"Learning from mistakes" means one specific thing:** past calls + their
  outcomes are fed back into the prompt as *context* so the model can see its own
  record and stay honest about its confidence. The model is **not** retrained or
  fine-tuned and does **not** improve between runs. There is **no self-training**.
  (See comments in [`src/claude.ts`](./src/claude.ts) and
  [`src/evaluate.ts`](./src/evaluate.ts).)

### How the track record is scored (and its limits)

Calls are scored as **outperformance vs a benchmark index**, not raw direction —
because in a rising market almost everything rises, so "the price went up" mostly
measures market drift, not skill. The index level (NIFTY 50 `^NSEI` for NSE,
SENSEX `^BSESN` for BSE) is stored *when the call is made*.

- `Add` (Buy more) is **right** if the stock **outperformed** the index.
- `Trim` / `Avoid` (Sell) are **right** if the stock **underperformed**.
- `Hold` / `Watch` are **not scored**.
- It's a **rough ~1-trading-day horizon** ("the level at the next run"): no exact
  session alignment, ignores intraday moves and dividends. A blunt, honest proxy
  — not a backtest.

### Confidence calibration

Each run also checks whether the model's **confidence** means anything: the
per-confidence hit rate (do `High` calls beat `Low`?) and a **Brier score**
(using a documented map: Low 0.55 / Medium 0.65 / High 0.75; 0.25 = always
guessing 50/50, lower is better). This is fed back into the prompt and shown on
the dashboard. It needs a few weeks of calls before it means much.

---

## Setup

### 1. Add your Anthropic API key as a secret

1. Get a key at [console.anthropic.com](https://console.anthropic.com/) →
   **Settings → API keys**.
2. **‼️ Add credits.** Console → **Plans & Billing** → add a few dollars. With a
   $0 balance the API returns *"credit balance is too low"* and every read falls
   back to "analysis unavailable". (Each run costs a few cents.)
3. In the repo: **Settings → Secrets and variables → Actions → New repository
   secret** → name it exactly `ANTHROPIC_API_KEY`.
4. (Optional) Add a repository **variable** `MODEL` to override the model
   (default `claude-sonnet-4-6`).

### 2. Turn on GitHub Pages

**Settings → Pages → Build and deployment**:
- **Source:** Deploy from a branch
- **Branch:** `claude/gifted-bardeen-xmfQn` (or `main` after you merge) and folder
  **`/docs`** → **Save**.

Your dashboard will be at `https://<your-username>.github.io/<repo>/`
(e.g. `https://krishang17.github.io/stock-market-portfolio-assist/`).

### 3. Edit your portfolio

Edit [`portfolio.json`](./portfolio.json) directly on GitHub — an array of:

```json
{ "symbol": "RELIANCE", "name": "Reliance Industries", "exchange": "NS", "qty": 10, "buyPrice": 1200.0 }
```

- `symbol` — base ticker, no suffix.
- `exchange` — `"NS"` (NSE → `.NS`) or `"BO"` (BSE → `.BO`).
- `qty`, `buyPrice` — your position (for the P/L line). Use your **split-adjusted**
  cost, since Yahoo prices are split-adjusted.

---

## Running and testing

- **Automatic:** the workflow runs daily (`cron: "0 3 * * *"` = 08:30 IST). It
  generates `docs/briefing.json` + updates `data/history.json`, commits them, and
  Pages republishes the dashboard.
- **Manual:** repo → **Actions → Morning Briefing → Run workflow** (pick the
  branch). Note: a green run only means it didn't crash — check the **dashboard**
  (or the run logs) to confirm Claude actually produced reads vs. fallbacks.
- **Locally:**
  ```bash
  npm install
  cp .env.example .env     # add your ANTHROPIC_API_KEY
  npm run briefing         # writes docs/briefing.json + data/history.json
  npx serve docs           # or: python3 -m http.server -d docs 8080
  ```
  Then open the served page. `npm run typecheck` type-checks without running.

A note: hit rate and calibration need **two runs** to appear — run #1 makes
calls, run #2 scores them.

---

## How it works

| File | Responsibility |
| --- | --- |
| [`src/prices.ts`](./src/prices.ts) | Yahoo Finance price + index lookups (try/catch-guarded). |
| [`src/claude.ts`](./src/claude.ts) | Anthropic Messages API + `web_search`; per-holding reads & ideas, **with source links**; robust JSON parsing. |
| [`src/evaluate.ts`](./src/evaluate.ts) | Benchmark-relative scoring, hit rate, and calibration. |
| [`src/index.ts`](./src/index.ts) | Orchestrator → writes `docs/briefing.json` + `data/history.json`. |
| [`docs/`](./docs) | The static dashboard (`index.html`, `app.js`, `style.css`) Pages serves. |
| [`portfolio.json`](./portfolio.json) | Your holdings. |
| [`data/history.json`](./data/history.json) | The persisted track record. |

Secrets/variables: `ANTHROPIC_API_KEY` (secret, required), `MODEL` (variable,
optional). The workflow commits data back using the built-in `GITHUB_TOKEN`
(`permissions: contents: write`, as `github-actions[bot]`).

## Changing the schedule

Edit the `cron` in [`.github/workflows/briefing.yml`](.github/workflows/briefing.yml)
(UTC; IST = UTC + 5:30). GitHub cron is best-effort and can be delayed, and
scheduled workflows pause after ~60 days of repo inactivity.

## License

MIT. Use at your own risk — again, **information, not financial advice.**

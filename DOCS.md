# DIBBS RFQ Browser – design notes and every decision explained

This document explains what was built, how the DIBBS website actually behaves, which
data source was chosen and why, how every file in the repository works, and the
reasoning behind each filter and each tradeoff. It is written so that someone who has
never seen DIBBS can follow it from top to bottom.

---

## 1. The task in one paragraph

The assignment (TASK.odt) asks for a full-stack web app that pulls the daily Requests for
Quotation (RFQs) from DIBBS (https://www.dibbs.bsm.dla.mil/RFQ), stores them, and lets a
vendor browse, search and filter them, with every row linking back to its original page on
DIBBS. Minimum fields: solicitation number and NSN. Extra fields welcome. Judged on UX,
speed, filter choices, problem solving and product sense. The additional instruction for
this build was: create a Docker database, start pulling from `https://www.dibbs.bsm.dla.mil//rfq/`,
and keep the code base extremely simple ("like a 5 year old, but functional").

---

## 2. What the repository contains

| File          | Lines | Job |
|---------------|-------|-----|
| `db.sh`       | ~20   | Starts Postgres in Docker (port 5434) and runs `schema.sql`. Idempotent. |
| `schema.sql`  | ~35   | Two tables: `rfqs` (the data) and `pulled_files` (which daily files were already downloaded). |
| `pull.js`     | ~200  | Goes to DIBBS, clicks through the DoD consent page, finds the daily index files, downloads them, cuts each line into columns, saves rows. |
| `server.js`   | ~160  | Plain `http` server. Serves `index.html` and two JSON endpoints: `/api/rfqs` (search + filters + paging) and `/api/filters` (dropdown values). |
| `index.html`  | ~360  | The UI. One file, no framework, no build step. |
| `package.json`| ~15   | One dependency: `pg`. Three scripts: `db`, `pull`, `start`. |
| `DOCS.md`     |       | This file. |
| `README.md`   |       | How to run it in 4 commands. |

There is intentionally no TypeScript, no bundler, no ORM, no frontend framework, no test
framework, no `.env` loader. The pre-existing scaffold (`tsconfig.json`, `typescript`, `tsx`)
was removed because none of it was needed and leaving it would have been confusing.

Total hand-written code is roughly 800 lines including HTML and CSS.

---

## 3. How DIBBS really works (what I found by probing it)

Everything below was discovered with `curl` before writing any code. These facts drive
the design, so they are listed first.

### 3.1 The DoD consent wall

Every first request to `https://www.dibbs.bsm.dla.mil/...` answers `302` to
`/dodwarning.aspx?goto=<original path>`. That page is a "Department of Defense Warning
and Consent" notice: a normal ASP.NET form with 24 chunked `__VIEWSTATE*` hidden fields,
`__EVENTVALIDATION`, and one submit button named `butAgree` with value `OK`.

Posting every input of that form back to the form's `action` URL sets a session cookie
and redirects to the `goto` path. From then on, as long as the cookies are sent, pages
load normally.

**Important detail:** the daily data files are served from a *second* host,
`dibbs2.bsm.dla.mil`, which has its *own* consent page and its own cookies. The first
attempt to download an index file returned the consent HTML instead of the file. The
puller therefore handles consent generically: *any* response whose body contains
"Warning and Consent" is treated as "press OK and continue", on whichever host it
appears. That one rule handles both hosts.

### 3.2 Where the RFQ data lives

Under `/rfq/` there are several ways to list RFQs:

1. **Search results grid** (`Rfq/RfqRecs.aspx?category=post&TypeSrch=dt&Value=MM-DD-YYYY`).
   An ASP.NET GridView: 50 rows per page, paged with `javascript:__doPostBack('ctl00$cph1$grdRfqSearch','Page$2')`.
   One day (2026-10-13) had 2,269 records = 46 pages. Paging only works if you POST the
   full ~145 KB viewstate back with `__EVENTTARGET`/`__EVENTARGUMENT` set. I got this
   working (pages 2, 3 and "Last" verified), but it means 46 large POSTs per day and
   fragile HTML parsing of nested `<span>`/`<a>`/`<img>` markup per cell.

2. **"Recent RFQs" page** (`Rfq/RfqDates.aspx?category=recent`). This is linked from the
   `/rfq/` landing page. It lists the last ~23 posting days and, for each day, three
   downloadable files:
   - `caYYMMDD.zip` – all the RFQ PDFs of that day
   - `inYYMMDD.txt` – a **fixed-width index** of every RFQ posted that day
   - `bqYYMMDD.zip` – a batch-quoting file

   DIBBS documents the index file layout on `Rfq/RfqFileDefs.aspx` ("RFQs Download Help").

**Decision: use the daily index files as the data source.**

Reasons, in order of weight:

- It is the route DIBBS itself provides for exactly this purpose ("Click the File Name to
  Download all RFQs for that date"). Using the sanctioned bulk file is more respectful of
  the site than paging through 46 grid pages per day.
- One `GET` per day instead of 46 `POST`s. The whole 23-day backlog (57,130 lines) pulls
  in about 30 seconds.
- The format is documented and fixed-width. Parsing is `line.substr(start, width)`. There
  is no HTML to parse at all, which keeps the code tiny and robust.
- It contains *more* fields than the HTML grid: unit of issue, buyer code, AMSC, item type
  indicator, set-aside code and set-aside percentage are only in the file.
- It still starts from the URL that was specified: the puller opens
  `https://www.dibbs.bsm.dla.mil//rfq/`, consents, follows the "Recent RFQs" link, and
  discovers the file links from that page instead of guessing file names.

What the index file does **not** have, compared with the HTML grid:

- the "Technical Documents" flag and the "Mil-Spec" tag
- the "RFQ/Quote Status" column (we derive open/closed from the return-by date instead)
- **today's RFQs.** DIBBS appends to the current day's file during business hours and
  only publishes its link the next day, so the newest file is always yesterday's.
  For a vendor scanning opportunities this is a real but acceptable gap for an MVP;
  section 10 explains how the already-verified grid paging could fill it.

### 3.3 The index file layout

Every line is exactly 140 characters (plus CR LF). Column widths from DIBBS's help page,
verified against real lines:

| Start | Width | Column | Example | Stored as |
|------:|------:|--------|---------|-----------|
| 0   | 13 | Solicitation # | `SPE1C126Q0524` | `solicitation` |
| 13  | 46 | NSN / Part # | `8345002929415` | `nsn`, and `fsc` = first 4 digits |
| 59  | 13 | Purchase Request # | `7017430272` | `pr` |
| 72  | 8  | Return By Date `MM/DD/YY` | `10/20/26` | `return_by` (DATE) |
| 80  | 19 | File Name | `SPE1C126Q0524.pdf` | `file_name` |
| 99  | 7  | QTY | `0000100` | `qty` (INTEGER) |
| 106 | 2  | Unit of Issue | `EA` | `unit` |
| 108 | 21 | Nomenclature | `PLATE,AUTOMOBILE,IN` | `nomenclature` |
| 129 | 5  | Buyer Code | `DQV00` | `buyer_code` |
| 134 | 1  | AMSC | `G` | `amsc` |
| 135 | 1  | Item type: 1 = NSN, 2 = part number | `1` | `item_type` |
| 136 | 1  | Set-aside code | `N` | `set_aside` |
| 137 | 3  | Set-aside percentage | `000` | `set_aside_pct` |

Set-aside codes (from the DIBBS legend): `N` Unrestricted, `Y` Small Business, `H` HUBZone,
`R` Service-Disabled Veteran-Owned, `L` Woman-Owned, `A` 8(a), `E` Economically Disadvantaged
Woman-Owned. DIBBS says a blank means Unrestricted, so the parser defaults blank to `N`.

Two values are *derived* rather than read:

- `posted_date` comes from the file name (`in261013.txt` → `2026-10-13`). The file is the
  posting day; the line itself carries no issue date.
- `sol_type` is the 9th character of the solicitation number (`Q`, `T` or `U`). In the
  data, 89 % are `T`, which DLA uses for its automated small-purchase RFQs, `Q` are the
  manually evaluated ones and `U` is the remainder. The letter is shown and filterable
  because vendors treat these very differently (T-type are usually small, fast,
  auto-evaluated buys). The exact DLA definition is not stated on the pages I read, so the
  UI labels them conservatively.

Fixing one real data wart: for the 95 part-number items (0.2 %) the first four characters
of the "NSN" column are things like `S431` or `7Z04`, not a Federal Supply Class. Those
rows get an empty `fsc` so the FSC filter list stays clean.

### 3.4 Links back to DIBBS (requirement 5)

Verified against the live grid HTML:

- **Row's own page** ("Package View"): `https://www.dibbs.bsm.dla.mil/rfq/rfqrec.aspx?sn=<solicitation>`
- **Solicitation PDF**: `https://dibbs2.bsm.dla.mil/Downloads/RFQ/<d>/<FILE>.PDF` where `<d>` is the
  last character of the solicitation number. Checked on 67 of 67 links across three grid pages.
- **All RFQs for this NSN**: `https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=<nsn>&category=post&Scope=`
- **Submit a quote**: `https://www.dibbs.bsm.dla.mil/RA/Quote/QuoteFrm.aspx?sn=<solicitation>` (needs a DIBBS login)

A human clicking these will hit the same consent page once per browser session; that is
how DIBBS works for everyone and cannot be bypassed from our side.

---

## 4. Stack decisions

| Choice | Why |
|--------|-----|
| **Node 20, plain JavaScript, CommonJS** | Already on the machine. Node 20 has a built-in `fetch`, `URL`, `URLSearchParams`, `TextDecoder` and `headers.getSetCookie()`, so the puller needs zero HTTP libraries. Plain `.js` runs with `node file.js`, no compile step. |
| **One dependency: `pg`** | A database driver is the only thing the standard library cannot do. `pg` is the de-facto Postgres client and its API is three calls: `connect`, `query`, `end`. |
| **Postgres 16 in Docker** | The task asked for a Docker database. Postgres was chosen over MySQL/SQLite because `ILIKE`, `= ANY(array)`, `count(*) FILTER (...)`, `ON CONFLICT ... DO UPDATE` and date arithmetic (`return_by - CURRENT_DATE`) each save real code. The `postgres:16-alpine` image was already present locally. Host port **5434** was picked because 5432 and 5433 were in use by other containers on this machine. |
| **No ORM, no migrations tool** | `schema.sql` with `CREATE TABLE IF NOT EXISTS` is re-run by `db.sh` every time; that is the whole migration system. |
| **Built-in `http` module instead of Express** | Two routes and a static file do not justify a framework. The routing is three `if` statements. |
| **Vanilla HTML/CSS/JS frontend, single file** | No React, no build, no node_modules for the browser. The page is served as-is. Rows are rendered by string concatenation with an `escapeHtml` helper. This is the simplest thing that still looks and feels like a product. |
| **Web port 8787** | 8080, 3000 and 3001 were already taken on this machine. |
| **Credentials hard-coded (`dibbs`/`dibbs`)** | Local prototype on a local Docker container. Putting them in a `.env` loader would add a dependency or more code for no security gain here. The connection string is one constant at the top of each file. |

---

## 5. Database schema decisions

```
rfqs (solicitation, pr) PRIMARY KEY
```

- **Grain = one line of the index file = one purchase request (PR) on one solicitation.**
  One solicitation can carry several PRs (same NSN, different delivery orders), and that is
  how DIBBS displays it too (one grid row per PR). The vendor quotes per solicitation but
  evaluates per line, so the line is the right unit for browsing.
- **Why `ON CONFLICT (solicitation, pr) DO UPDATE`:** the 23 files contained 57,130 lines but
  only 52,172 unique (solicitation, pr) pairs. DIBBS re-posts amended RFQs on a later day.
  Updating means the row carries the newest return-by date and newest posted date, which is
  what a vendor wants, and it makes `pull.js --all` safely re-runnable.
- **`pulled_files` table:** remembers which daily files were already imported, so a normal
  run only downloads new days. The row is written in the same transaction as the data, so
  an interrupted import is simply retried next run.
- **Indexes** on `return_by`, `posted_date` and `fsc`: the three columns every default
  query touches. Free-text search uses `ILIKE '%x%'` over four columns with no index; on
  52k short rows that is ~10–20 ms, which is well under what a user notices. A trigram
  index would be the upgrade if the table grew to millions of rows.
- **Everything `NOT NULL`, text codes stored as the raw letter.** Names for the letters
  live in one small map in the frontend. The database stays exactly what DIBBS published.
- `qty` is `INTEGER` so quantity range filters and sorting work numerically.
- `return_by` and `posted_date` are `DATE` so "open", "closing within N days" and "days left"
  are computed by Postgres against `CURRENT_DATE` and never go stale in the browser.

---

## 6. The puller (`pull.js`) in detail

Reading order matches execution order:

1. **Cookie jar.** `fetch` forgets cookies, so a plain object keeps `{host: {name: value}}`.
   `rememberCookies` reads `Set-Cookie` headers from every response; `cookieHeader` builds the
   `Cookie` header for a host. Cookies are kept per host because `www.dibbs...` and
   `dibbs2...` are separate consent domains.
2. **`request(url, method, body)`** does one fetch with `redirect: "manual"` and follows up to
   10 redirects by hand. Manual following is required because the consent cookie is set *on
   the redirect response*; automatic following would drop it. The body is decoded as
   `latin1` because DIBBS declares `charset=ISO-8859-1`.
3. **Consent handling.** `getPage(url)` fetches; if the body contains "Warning and Consent",
   it collects every `<input name= value=>` of the page into a form, POSTs it to the form's
   `action` (resolved against the page URL), and the redirect lands on the originally
   requested page. If the consent page comes back a second time it throws, so a change on
   DIBBS's side fails loudly instead of silently importing nothing.
4. **Discovery.** Open `//rfq/` (the given start URL, which also primes the consent cookie),
   then the Recent RFQs page, then regex every `https://dibbs2.bsm.dla.mil/Downloads/RFQ/Archive/inYYMMDD.txt`
   link. Sorted ascending so older days import first and re-posts naturally overwrite.
5. **Import.** Per file: skip if already in `pulled_files` (unless `--all`), download, split
   on newlines, keep lines of at least 140 characters, `parseLine` each, insert inside one
   `BEGIN`/`COMMIT`. One transaction per file turns ~2,000 inserts into one fsync and keeps
   each day all-or-nothing.

Deliberately *not* done: concurrency, retries with backoff, streaming, a scheduler. A cron
line (`0 6 * * * cd ... && node pull.js`) is the intended way to run it daily.

---

## 7. The API (`server.js`) in detail

`GET /api/rfqs` accepts these query parameters; everything is optional:

| Param | Meaning | SQL |
|-------|---------|-----|
| `q` | free text | `solicitation/nsn/pr ILIKE %q-without-dashes%` OR `nomenclature ILIKE %q%` |
| `status` | `open` (default), `closed`, `all` | `return_by >= CURRENT_DATE` etc. |
| `closing_days` | deadline within N days | `return_by <= CURRENT_DATE + N` |
| `set_aside` | comma list of codes | `set_aside = ANY($n)` |
| `fsc` | comma list of 4-digit codes | `fsc = ANY($n)` |
| `posted` | one date | `posted_date = $n` |
| `min_qty`, `max_qty` | quantity range | `qty >= / <=` |
| `sol_type`, `amsc`, `item_type` | single codes | equality |
| `sort` | one of a fixed allow-list | `ORDER BY` picked from a map, never from user text |
| `page` | 1-based, 50 per page | `LIMIT 50 OFFSET` |

Why the search strips dashes: DIBBS *displays* `SPE1C1-26-Q-0524` and `8345-00-292-9415`
but *stores* `SPE1C126Q0524` and `8345002929415`. A vendor will paste the dashed form from
an email. Stripping dashes from the typed text before matching the code columns makes both
forms work; nomenclature is matched as typed because it legitimately contains commas and
dashes.

Why two queries (count + rows): the UI needs "18,052 RFQs match" and "page 1 of 362".
`count(*) OVER()` in one query would be marginally faster but harder to read.

Safety: every user value goes through `$1..$n` parameters; sort keys are looked up in an
object; unknown routes get 404; any thrown error becomes a JSON 500 with the message.
Garbage input (`page=abc`, `sort=evil`, `set_aside=';drop`) was tested and returns an
empty or default result rather than an error.

`GET /api/filters` returns counts per set-aside, per FSC, per posting day, per
solicitation type and per AMSC code (open RFQs only where that is what a vendor cares
about), plus totals and the last pull time. The UI builds its dropdowns from this so
options always reflect real data and show how many rows each would give.

---

## 8. Filter choices and the product reasoning behind them

The question asked by the brief is "which filters you picked, and why". A vendor
evaluating DIBBS opportunities asks, in roughly this order:

1. **Am I even allowed to quote?** → **Set-aside** (multi-select pills with counts).
   A large business can only bid Unrestricted; a woman-owned small business wants
   `N`, `Y` and `L` together. Multi-select is essential; a single dropdown would force
   several searches.
2. **Is it something I sell?** → **FSC codes** (comma-separated, with an autocomplete list
   of the 340 classes currently open and their counts) plus **free text** over
   nomenclature. Vendors think in FSCs (5306 = bolts, 6515 = medical instruments). Allowing
   several at once matches how suppliers cover a few adjacent classes.
3. **Is there still time?** → **Status** defaults to *Open*, and **Closing within** 2/5/10/20
   days finds the ones needing attention now. The table shows "today / in 2 d" in red
   under 3 days and amber under 7 so urgency is visible without filtering.
4. **Is it worth the effort?** → **Qty min / max**. Median quantity is 8; many vendors
   skip one-piece buys, others specialise in them. Sorting by quantity in both directions
   serves both.
5. **What kind of buy is it?** → **Type** (`Q`/`T`/`U`) and **AMSC**. AMSC tells a vendor
   whether the item is competitive or source-controlled (e.g. `G` means the government has
   full technical data; `C`/`D`/`P`/`R` indicate restrictions). Included as a plain code
   filter with counts; experienced DLA vendors know these letters.
6. **What's new?** → **Posted on** one specific day, mirroring DIBBS's own "RFQs by issue
   date" page, and **Sort by posted** for a daily scan.
7. **NSN vs part number** → **Item** filter, since part-number buys need a different
   evaluation (no NSN history to look up).

Filters not included, and why: buyer code (useful to insiders only, still shown as a
column and searchable by sorting), unit of issue (rarely a decision factor), set-aside
percentage (it is always `000` or `100` in the data, so it adds nothing beyond the code).

---

## 9. UI decisions

- **Dense table, sticky header, 50 rows per page.** Vendors scan hundreds of rows; density
  beats cards. Pagination instead of infinite scroll keeps the code at two buttons.
- **Two lines per cell where DIBBS does the same** (solicitation + PR, NSN + FSC,
  return-by + days left) so the table stays narrow while keeping all identifiers visible.
- **Search debounced at 250 ms**; every select applies instantly; *Reset* restores the
  defaults. There is no "Apply" button because every query is ~15 ms.
- **Header line** shows open/total counts, the newest day in the database and the last pull
  time, so a user immediately knows how fresh the data is (important given the
  one-day lag described in 3.2).
- **Links**: solicitation → Package View (the row's original page); NSN → NSN history;
  PDF → the solicitation document; Quote → DIBBS quote form. All open in a new tab.
- **Colour** is used only for meaning: set-aside badges (grey unrestricted, green small
  business, amber other set-asides) and deadline urgency.
- Filter state is **not** stored in the URL. It would be a nice follow-up for sharing
  links, but it roughly doubles the frontend state code.

---

## 10. Known limitations and what I would do next

1. **Today's RFQs are missing until tomorrow** (DIBBS publishes the file link one day
   late). Fix: a second, small puller that uses the grid paging already proven in testing
   (`RfqRecs.aspx?category=post&TypeSrch=dt&Value=<today>` + `__doPostBack` `Page$N`) only
   for the current day. It was left out to keep the code base to one data path.
2. **No "Technical documents available" flag**, because it only exists in the HTML grid.
   Same fix as above.
3. **235 rows have a return-by date earlier than their posted date** (oldest 2024-01-25).
   These are what DIBBS published, apparently re-posted old solicitations. They are kept
   as-is and simply show as *closed*.
4. **Single-process, no auth, no HTTPS.** Fine for a local tool; a deployment would put it
   behind a reverse proxy.
5. **No automated tests.** Verification was done by hand: the puller's row counts match the
   file line counts, the API was exercised with ~10 curl queries including malicious
   input, and the page was screenshot in headless Chrome.
6. **Scheduling** is left to cron.

---

## 11. How it was verified

- DoD consent flow: proven with curl on both hosts, then again from Node.
- Grid paging: pages 2, 3 and Last fetched correctly (row numbers 2,3,4 / 1739… / 19 rows
  on page 46 of 2,269 records). Documented so the alternative is known to work.
- Index file: 2,204 lines, every one exactly 141 bytes (140 + CR); column slices checked
  against the DIBBS legend and against the same rows in the HTML grid.
- PDF folder rule (last digit of the solicitation): 67/67 links matched.
- Import: 23 files, 57,130 lines, 52,172 unique rows, ~32 s; zero empty nomenclatures,
  one zero-quantity row (as published), all 13-digit NSNs for item type 1.
- API: default query 18,052 open rows in 50 ms; combined filter (text + 2 FSCs + 2 set-aside
  codes + closing in 5 days + min qty + sort) 99 rows; dashed solicitation and dashed NSN
  searches both find the row; junk parameters return an empty page, not an error.
- UI: rendered in headless Chrome at 1440×1000 and inspected.

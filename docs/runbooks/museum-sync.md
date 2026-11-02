# Runbook: museum sync and curation

For the owner. It covers the weekly Wikidata and RCE sync, the first import, the two queues, the empty guard, curation of the Museumkaart flag and prices, fixture recording and the P1a [box] dry run. The code wins where this text differs: report the difference.

Commands run from the repository root as `node apps/server/src/main.ts <role> …` (Node 26.10.0). In production the database login comes from the file secrets (`sync-museums` and `worker` as `mjk_worker`, `admin` as `mjk_api`). `DATABASE_URL` overrides every login and is for a throw-away database only (§11).

## 1. What the sync does

- One run is one Wikidata SPARQL query and one RCE WFS request, as `mjk_worker`. Hosts: `query.wikidata.org` and `services.rce.geovoorziening.nl` only; no other host is reachable (`apps/server/src/museums/sources/http.ts`).
- One advisory lock allows one sync at a time. A second run ends `sync_busy`.
- Both answers are parsed, then the empty guard (§6) decides whether anything is applied. Then the whole plan is written in one transaction.
- **Auto-applied (the safe set, default deny):** website, street, house number, postcode, place, municipality, `name_en`, both descriptions, `museumnl_url`, `registered`, `rce_id`, coordinates that appear or move less than 250 m, and new aliases. Each leaves a `museum_change` with origin `sync` and state `applied`.
- **Waits for you (a `pending` change):**
  - the name
  - coordinates that move 250 m or more
  - categories
  - `commons_file`
  - `closed_on` (Wikidata P576)
  - any safe field that goes from a value to null
  - `presence`: a source row that disappeared
- **Waits for you in the match queue (§5):** a museum that is new after the seed (`no_candidate`), a new QID at a museum we hold (`qid_link`, `qid_conflict`), two candidates (`ambiguous`), two RCE rows on one museum (`duplicate`). A new QID never links by itself.
- Fields you pinned (`pinned_fields`) are skipped.
- **Nothing is ever deleted.** Not a museum, not an alias. A museum that vanishes from a source gets a `presence` change; you decide. Aliases are only added.
- A re-run on unchanged input writes no row.
- **Every museum starts as `unknown` for the Museumkaart.** The sync cannot touch the Museumkaart columns, prices or lists (`mjk_worker` has no grant on them).
- A run prints and logs one summary of counts and fixed codes: never a name, URL or payload. Log lines: `sync_applied`, `sync_dry_run`, `sync_refused`, `sync_failed`; for jobs `job_done`, `job_retry`, `job_failed`.

## 2. The schedule

- `worker` enqueues `museum_sync` every Tuesday at 03:17 Europe/Amsterdam [U] (`apps/server/src/worker/schedule.ts`), unless one is already queued or running. The job has no payload and runs the same code as `sync-museums` without flags (mode `sync`).
- **Final, the job fails at once with its code:** `empty_guard`, `not_seeded`, `unknown_kind`.
- **Retried:** `sync_busy`, `wikidata_unavailable`, `rce_unavailable`, `apply_failed` and `internal`. Up to `max_attempts` = 5 tries in all. The wait after attempt n is 15 minutes doubling, capped at 6 hours [U]: 15, 30, 60, 120 minutes.
- Inside one try the fetcher itself retries 429 and 503 (§10).
- **Lease:** a running job unfinished after 30 minutes [U] can be taken over by a worker. One with no attempts left becomes `failed` with `lease_expired`.
- The state is in the tables `job` (`state`, `attempts`, `last_error`) and `museum_sync_run` (`outcome`, `code`, `wikidata_rows`, `rce_rows`, `counts`).

## 3. The first import (the seed)

`museum` is empty until you seed. The weekly job refuses (`not_seeded`) until then.

```bash
node apps/server/src/main.ts sync-museums --seed --dry-run   # writes nothing, prints the summary
node apps/server/src/main.ts sync-museums --seed             # creates the catalogue
```

- The seed runs only while `museum` is empty. On a filled table it ends `already_seeded` (exit 65).
- It creates every non-dissolved Wikidata museum directly and matches RCE rows against them. After the seed, a new museum waits in the match queue (`no_candidate`); `match resolve --new` creates it.
- First-run floors [U]: at least 1,000 Wikidata and 500 RCE rows, else `empty_guard` with `below_floor`. The expected size is about 1,361 and 629 rows [U].
- Read the dry-run summary before the real seed: rows per source, `invalid`, `coverage` and `counts.queued` (rows that will wait for you).

## 4. A weekly run by hand

```bash
node apps/server/src/main.ts sync-museums --dry-run   # the plan; nothing written, not even a run row
node apps/server/src/main.ts sync-museums             # apply
```

- Flags (`apps/server/src/main.ts`): `--dry-run`, `--seed`, `--accept-drop wikidata|rce`. Each at most once; anything else is a usage error (exit 64).
- The dry run plans inside a READ ONLY transaction. It still fetches both sources, so it counts as a run for Wikimedia's limits (§10).
- Summary keys: `mode`, `dryRun`, `outcome`, `code`, `sources` (status, rows, ms), `invalid`, `notes`, `baseline`, `coverage`, `counts` (created, matched per rule, kept, queued per reason, ignored, applied and pending per field, superseded, pinned, gone, returned, unchanged).

## 5. Working the two queues

### The match queue

A source row the matcher could not place waits in `museum_source_row`. Reasons:
- `no_candidate` (a new museum)
- `ambiguous` (two candidates passed the deciding rule)
- `qid_conflict` (a new QID at a museum that has another QID: a merge or redirect)
- `qid_link` (a new QID at a museum without one)
- `duplicate` (two RCE rows on one museum)

A dissolved Wikidata item with no museum is ignored by itself.

```bash
node apps/server/src/main.ts admin match list [--source wikidata|rce] [--reason <reason>]
```

```bash
node apps/server/src/main.ts admin match resolve <source>:<external_id> --museum <museum>
```

```bash
node apps/server/src/main.ts admin match resolve wikidata:<QID> --museum <museum> --replace-qid
```

```bash
node apps/server/src/main.ts admin match resolve <source>:<external_id> --new
```

```bash
node apps/server/src/main.ts admin match resolve <source>:<external_id> --ignore
```

- `<museum>` is a QID, a slug or an id; `<source>:<external_id>` is what `match list` prints (`wikidata:Q123`, `rce:overzichtmusea.12`).
- `--museum`: this row is that museum (`match_rule 'admin'`). Every later run keeps the decision.
  - An RCE row sets the museum's `rce_id`; a museum that already holds another RCE row is refused (`rce_conflict`).
  - A Wikidata row sets the museum's QID when it has none (recorded as `qid_link`). A museum with another QID is refused (`qid_conflict`) unless you add `--replace-qid`; use it only when Wikidata merged or redirected the old item. The old QID's row then waits as `presence`.
- `--new`: creates a museum from the row's stored payload (checked first: `bad_payload`), with a unique slug and the Wikidata aliases, and links the row (recorded as `new_museum`). A museum made from an RCE row alone takes the RCE name and address; when a Wikidata row is linked to it later, Wikidata's name arrives as a pending `name` change.
- `--ignore`: the row is never matched or created again; nothing is written to the museum.
- Fixed codes (exit 65): `not_queued`, `qid_conflict`, `rce_conflict`, `bad_payload`, `already_taken` (the QID or RCE id belongs to another museum), `check_failed`. An unknown row (`row_not_found`) or museum exits 66.

### The change queue

```bash
node apps/server/src/main.ts admin change list [--field <field>] [--museum <museum>]
```

```bash
node apps/server/src/main.ts admin change apply <id>
```

```bash
node apps/server/src/main.ts admin change apply <id> --keep | --hide | --close <YYYY-MM-DD>   # presence only
```

```bash
node apps/server/src/main.ts admin change reject <id>
```

- What lands here:
  - a name change, a move of 250 m or more (one `coordinates` change with `{lat, lon}`), `categories`
  - a new or changed P18 (`commons_file`), a P576 closure (`closed_on`)
  - a safe field going to null
  - `presence` (a row gone from its source)
- `apply` checks the new value against its column first (`bad_value`), then writes it. The change becomes `applied` in the same transaction.
- A `presence` change needs exactly one of these (64 otherwise):
  - `--keep`: the museum stays as it is; the change becomes `rejected`
  - `--hide`: `hidden`
  - `--close <date>`: `closed_on`
- `reject` keeps the museum as it is. **A rejection stands:** a later sync with the same news does not queue it again (it is counted as `declined`); different news for that field queues as usual. To keep a value against every future source change, pin the field instead.
- **Superseded:** when the source later shows other news for the same field, the older pending change becomes `superseded`; when the source reverts to what we hold, the change is moot and also `superseded`. Nothing to do for a superseded change.
- Fixed codes (exit 65): `not_pending`, `bad_value`, `unsupported_field`, `check_failed`. An unknown id (`change_not_found`) exits 66.

## 6. The empty guard

The guard stops a run that would apply nothing sensible because a source looks broken. Per source, the run is **refused** (`empty_guard`, exit 65, not retried) when:

- `schema`: the answer fails its envelope check
- `invalid_rows`: more than 2 % [U] of its rows are invalid
- `below_baseline`: under 90 % [U] of the rows of the last *applied* run
- `below_floor`: a first run with under 1,000 Wikidata or 500 RCE rows

What to check: `sources.<source>.status` in the summary names the reason; `invalid` lists the row codes; `baseline` shows what it was compared with. Look at the source itself (the query by hand on query.wikidata.org, the RCE service in a browser) before you decide the drop is real.

If it is real (a genuine clean-up at the source):

```bash
node apps/server/src/main.ts sync-museums --dry-run --accept-drop wikidata
node apps/server/src/main.ts sync-museums --accept-drop wikidata   # or rce
```

- `--accept-drop <source>` skips only the baseline and floor check of that source, for that one run. `schema` and `invalid_rows` still refuse.
- The baseline is the row count of the last **applied** run, so it moves only with an applied run. A refused or failed run never lowers it. After an accepted drop the lower count is the new baseline.
- Every refusal, with its `accept_drop` value, is kept in `museum_sync_run`.

## 7. Curation

**The rule:** the Museumkaart flag comes from each museum's own website and members' moderated reports. **Never** from museum.nl's list or filter, and never copied from them (A§7.5, A§13.3). The sync never sets it. A9's database-right answer comes before you curate real flags (A6).

```bash
node apps/server/src/main.ts admin museum flag <museum> participating|left|unknown [--since D] [--until D] [--verified D]
node apps/server/src/main.ts admin museum price <museum> <cents> [--verified D]
node apps/server/src/main.ts admin museum price <museum> --clear [--verified D]
```

- `<museum>` is a QID, a slug or an id. Dates are `YYYY-MM-DD`. `--verified` defaults to now. `left` needs `--until`; an `until` before `since` is refused.
- A price is whole cents, 0 to 20000.
- Each changed column leaves a `museum_change` (origin `admin`, state `applied`).

**Bulk: the CSV.**

```bash
node apps/server/src/main.ts admin museum export --csv museums.csv
node apps/server/src/main.ts admin museum import --csv museums.csv --dry-run
node apps/server/src/main.ts admin museum import --csv museums.csv
```

- Read-only context columns: `id`, `wikidata_qid`, `slug`, `name`, `place`. Editable: `museumkaart_status`, `mk_since`, `mk_until`, `mk_last_verified_at`, `admission_adult_cents`, `price_verified_at`, `photo_policy`, `closed_on`, `temp_closed`, `temp_closed_until`, `hidden`. Keep the header exactly.
- The file is RFC 4180 (CRLF, quoted fields, UTF-8; a BOM is fine). Open it in a tool that keeps text as text and does not reformat dates.
- **Formula injection:** a read-only cell that starts with `=`, `+`, `-`, `@`, a tab or a CR is exported with a leading `'`. Import strips that one `'` from the read-only columns only. Do not add the prefix yourself.
- **Refusal rules:** any issue refuses the whole file and writes nothing (exit 65; one line per issue with row and column, never the cell value; at most 50). Issues: a bad quote, a wrong header, a wrong number of cells, an invalid cell, a duplicate or unknown `id`, an `id` whose QID differs from the database (a shifted row), and a value that breaks a table check.
- `--dry-run` runs in a READ ONLY transaction and prints the same counts. Run it first.
- Only changed cells are written; the report gives rows read, rows changed and counts per field.

**The frozen list.** N is never typed.

```bash
node apps/server/src/main.ts admin list publish [--date D]
node apps/server/src/main.ts admin list show
```

- `publish` copies the museums that are `participating` and not hidden into a new list version. N is the number of members copied. Changing a flag afterwards changes neither N nor its date.
- It refuses a second version on the same date (`list_exists`) and an empty list (`list_empty`).
- `show` prints N and the list date, or `no list published`.

## 8. Exit codes and fixed codes

`sync-museums` (`apps/server/src/main.ts`):

| Exit | Meaning | Codes |
|---|---|---|
| 0 | applied, or a dry run | none |
| 64 | usage | a bad or repeated flag |
| 65 | refused | `empty_guard`, `not_seeded`, `already_seeded` |
| 69 | a source is unavailable | `wikidata_unavailable`, `rce_unavailable` |
| 70 | the transaction failed | `apply_failed` |
| 75 | another run holds the lock | `sync_busy` |
| 78 | database configuration missing or invalid | none |

`admin` (`apps/server/src/admin/cli.ts`, `apps/server/src/museums/curation.ts`):

| Exit | Meaning | Codes (printed as `admin: <code>`) |
|---|---|---|
| 0 | done | none |
| 1 | unexpected failure | `admin: failed (<SQLSTATE>)` |
| 2 | a group a later phase builds (`invite`, `user`) | none |
| 64 | usage | `bad_status`, `left_needs_until`, `bad_date`, `usage`, `presence_needs_choice`, `choice_only_for_presence`, or the usage line |
| 65 | bad data | `bad_price`, `check_failed`, `until_before_since`, `import_refused`, `list_exists`, `list_empty`, `not_queued`, `qid_conflict`, `rce_conflict`, `bad_payload`, `already_taken`, `not_pending`, `bad_value`, `unsupported_field` |
| 66 | not found | `museum_not_found`, `file_not_found`, `row_not_found`, `change_not_found` |
| 78 | database configuration missing or invalid | none |

Job codes (`job.last_error`):

| Code | Meaning | Retried |
|---|---|---|
| `empty_guard` | the guard refused | no |
| `not_seeded` | `museum` is empty | no |
| `sync_busy` | another run holds the lock | yes |
| `wikidata_unavailable`, `rce_unavailable` | a source could not be fetched | yes |
| `apply_failed` | the transaction failed | yes |
| `internal` | any error that is not a fixed code | yes |
| `unknown_kind` | no handler for the job's kind | no |
| `lease_expired` | running past the lease with no attempts left | no |

Source fetch codes in `sources.<source>.status`: `host_not_allowed`, `timeout`, `network`, `redirect`, `rate_limited`, `http_status`, `too_large`, `not_json` (`apps/server/src/museums/sources/http.ts`).

## 9. Recording fixtures (O1)

Owner's machine only. The script refuses under `CI` (exit 3) before it loads any fetcher code; a usage error exits 64, a failed fetch 1.

```bash
export MJK_SYNC_CONTACT='<your email or an https URL>'
node scripts/record-fixture.ts wikidata normal
node scripts/record-fixture.ts rce normal
node scripts/record-fixture.ts wikidata edge --qids Q1,Q2,Q3     # museums with odd data
node scripts/record-fixture.ts wikidata empty --qids Q1          # a QID the query returns nothing for
```

- Cases: `normal`, `edge`, `empty`. RCE records only `normal`. Wikidata `edge` and `empty` need `--qids` (at most 500 QIDs). Options: `--qids`, `--out <dir>` (default `apps/server/test/fixtures/museums`), `--contact` (default `MJK_SYNC_CONTACT`).
- It writes `<out>/<source>/<case>.json` and `<case>.meta.json`, and prints counts and a time, never rows.
- It sleeps 10 s when it made a Wikidata request less than 60 s ago (a stamp file in the temp directory). Do not record in parallel.
- Then regenerate the goldens, read the whole diff and commit:

```bash
pnpm test -- -u
git diff apps/server/test/fixtures
```

Check the golden diff for what you expect (row counts, no odd names or hosts) before you commit.

## 10. Wikimedia etiquette

- Every request carries `User-Agent: mjk-museum-sync/1.0 (+<contact>)`. `<contact>` is `MJK_SYNC_CONTACT`: an email address or an https URL, printable ASCII, at most 200 characters. It is config, not a secret. Without a valid value the repository URL is sent. Set it in the worker's environment before the first real run.
- One query per source per run. A dry run counts too.
- 429 and 503 are retried, 3 tries in all. The wait is `Retry-After` (seconds or a date, capped at 10 minutes), else 30 s, then 60 s. After the third the code is `rate_limited` and the run ends `*_unavailable`.
- Redirects are never followed. A body over 20 MB [U] is refused. The timeout is 90 s.
- Never hammer WDQS: no loops, no repeated runs within minutes, no recording and a sync at the same time. After a 429, wait.

## 11. The P1a [box] dry run (O2)

Before P1e there is no `mjk` stack on the VM. This is a throw-away set-up. It shares nothing with `rws` or `f1` (its own network and containers, no volume, no published port) and ends with a clean-up. **Never** point it at a shared server: `roles.sql` changes cluster-wide roles.

`DATABASE_URL` below holds the throw-away superuser password and exists only inside the second container. Here every command, `migrate` and `sync-museums` included, connects with that superuser, so the role grants are not exercised (the integration tests do that). The dry run is READ ONLY anyway.

From a checkout of the PR branch, on the VM:

```bash
docker network create mjk-p1a-tmp
PW=$(openssl rand -hex 16)
docker run -d --name mjk-p1a-db --network mjk-p1a-tmp \
  --tmpfs /var/lib/postgresql \
  -e POSTGRES_PASSWORD="$PW" \
  -e POSTGRES_INITDB_ARGS='--locale-provider=builtin --builtin-locale=C.UTF-8' \
  postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336
until docker exec mjk-p1a-db pg_isready -h 127.0.0.1 -U postgres; do sleep 1; done
```

Then roles, migrations and the dry run, in a Node container on that network (the A§4 build image; P1e pins it by digest, so use that digest once it exists). The checkout is mounted read-only and copied. dbmate 2.36.0 is sha-checked against the sha256 in `.github/workflows/ci.yml` (`DBMATE_SHA256`; re-read it there if it changed):

```bash
docker run --rm -i --network mjk-p1a-tmp -v "$PWD":/src:ro \
  -e DATABASE_URL="postgres://postgres:$PW@mjk-p1a-db:5432/postgres?sslmode=disable" \
  -e MJK_SYNC_CONTACT='<your email or an https URL>' \
  node:26.12.0-trixie-slim bash -s <<'EOF'
set -euo pipefail
apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null
curl --proto '=https' -fsSL -o /usr/local/bin/dbmate \
  https://github.com/amacneil/dbmate/releases/download/v2.36.0/dbmate-linux-amd64
echo "47e284b3d8cbad1ba5f090495aa05afd1bbd5f35e2ed5577aad06da74ce780ce  /usr/local/bin/dbmate" | sha256sum -c -
chmod +x /usr/local/bin/dbmate
mkdir /work && cp -a /src/. /work/ && cd /work
bash scripts/install-pnpm.sh /usr/local
pnpm install --frozen-lockfile
node apps/server/scripts/dev-db.ts                              # roles.sql
node apps/server/src/main.ts migrate                            # the migrate role
node apps/server/src/main.ts sync-museums --seed --dry-run      # the summary JSON is the last block
EOF
```

Clean up, whatever the result:

```bash
docker rm -f mjk-p1a-db
docker network rm mjk-p1a-tmp
unset PW
```

Paste into the PR: the summary JSON. It holds counts and codes only, no names. The lead writes it into A§7.1 to A§7.3: Wikidata rows, dissolved and ignored, invalid by code, RCE matched per rule and queued per reason, the coverage of coordinates, municipalities and postcodes, and the query time (`sources.wikidata.ms`).

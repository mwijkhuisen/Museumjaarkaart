# Runbook: accounts (P2a)

For the owner. The operator's view of sign-in, invites and the first admin, and the [box] checks to run after the P2a merge. The code wins where this text differs: report the difference.

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

## 1. Secrets and the deploy order

`app_keys` (63012) and `lettermint_api_token` (63008): format and creation in `docs/runbooks/install.md` §4, rotation in `docs/runbooks/secrets-rotation.md` §8 and §9. The order of the P2a deploy is `docs/runbooks/update.md` §8. The worker also needs `MJK_MAIL_FROM` in `/etc/mjk/mjk.env`; without it, or without a real token, mail jobs fail as `mail_unconfigured` or `mail_refused` and no code reaches anyone.

## 2. The first admin (O4), after the deploy

First deploy a server image that hashes at m = 56 MiB (built from the merge of PR #57 or later), and set no password before it runs. An image from 8621ef3 hashes at 19 MiB: a wrong password for such an account answers faster than the dummy for an unknown email, which tells an outsider the email has an account (A§9). After the deploy, and again after you set a password, this count must print `0`. It counts rows and reads no hash value:

```bash
mjkc exec -T db psql -X -U postgres -d mjk -Atc "select count(*) from app_user where password_hash is not null and password_hash not like '\$argon2id\$v=19\$m=57344,t=2,p=1\$%'"
```

Anything else means a password was set at the old parameters: sign in with it once (that rehashes it), then count again.

1. Create a one-use invite that lasts one day. The code is printed once and stored only as its HMAC:
   `mjkc --profile tools run --rm admin invite create --uses 1 --days 1`
2. Sign up at `https://<domain>/inloggen#uitnodiging=<code>` with your own address. The code mail arrives from `MJK_MAIL_FROM`.
3. Make yourself admin (the handle is the one you chose):
   `mjkc --profile tools run --rm admin user role <handle> admin`
4. Sign in on `https://admin.<domain>`: Cloudflare Access first (the same email), then the code.

Exit codes of both commands: 0 done · 64 usage · 66 unknown handle (`user role`) · 78 config (`app_keys` or the database). Both write one `audit_log` row of codes and counts, never an address, code or note.

## 3. Invites

Until P3d is merged, invites go only to the owner and test accounts (`admin invite create --uses N --days D [--email <address>] [--locale nl|en] [--note <text>]`; with `--email` the invite is mailed). The note holds no personal data.

## 4. The purge, every 10 minutes

The worker runs `apps/server/src/worker/purge.ts` as `mjk_worker` on the database clock and logs counts only (`purge_done`). It removes:

- sessions past their expiry or absolute expiry;
- email codes older than 24 hours;
- ALTCHA challenges after their expiry;
- rate-limit windows 24 hours after they ended;
- finished jobs (`done` or `failed`) after 30 days;
- invites 90 days after they expired or were last used up;
- `content_ip_log` rows after 30 days;
- the sealed values of mail jobs: a code job's once its code expired (10 minutes) or it failed, an invite or notice job's once it failed. Running jobs are untouched.

`audit_log` is never touched here (its purge function arrives in P3c).

## 5. The [box] checks after the merge

Their results went into a follow-up docs PR (B1 and B2 on 2026-11-27; B3 and B4 follow after A4).

### B1. argon2 on the VM

Ran on the image then deployed. The gate allows 2 hashes at once, so each m was measured alone and as a pair (`Promise.all` of two), in the steps of the script below. The rule: the highest step whose single median and pair median are both under 250 ms. The follow-up PR committed it to `apps/server/src/auth/argon2.ts` and A§9, and CI's e2e `@load` pass ran on it.

**Result (2026-11-27, image 8621ef3):** m = 56 MiB. Medians, one / two at once: 19 MiB 26 / 73 ms; 24 MiB 31 / 78; 32 MiB 40 / 105; 40 MiB 61 / 170; 48 MiB 59–80 / 164–174 (one first run of 406, noise on the shared VM); 56 MiB 68–88 / 187–202; 64 MiB 87–100 / 210–320 (over 250 ms in two of three runs). CI's `@load` pass at 56 MiB (50 parallel password sign-ins): the api restarted 0 times, no OOM kill, `memory.peak` 255,983,616 bytes (244 MiB of its 384 MB limit).

`dummyVerify` runs at the current parameters. m went up before production held any account, so no stored hash has the old m, provided this image is deployed before the first password is set (§2 has the order and the count). A later change of the parameters must not just add a dummy at the old ones: while hashes of more than one set are stored, every failed path costs one hash per stored set (a stored hash: its verify plus a dummy at each other set; an unknown email or no password: a dummy at every set), pinned by an integration test with an old-set hash next to a current one. Or rewrap the old hashes offline under the new parameters (A§9).

```bash
img=$(sed -n 's/^MJK_SERVER_IMAGE=//p' /srv/mjk/state/current.env)
docker run --rm --network none --cpus 1.0 --memory 384m --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 63532:63532 --entrypoint /usr/local/bin/node "$img" -e '
const {argon2,randomBytes}=require("node:crypto"),a=require("node:util").promisify(argon2);
const h=(mib)=>a("argon2id",{message:"correct horse battery staple",nonce:randomBytes(16),parallelism:1,tagLength:32,memory:mib*1024,passes:2});
const med=async(f)=>{const t=[];for(let i=0;i<8;i++){const s=process.hrtime.bigint();await f();
t.push(Number(process.hrtime.bigint()-s)/1e6)}t.shift();t.sort((x,y)=>x-y);return `median ${t[3].toFixed(0)} ms, max ${t.at(-1).toFixed(0)} ms`};
(async()=>{for(const mib of [19,24,32,40,48,56,64])
console.log(`${mib} MiB: one ${await med(()=>h(mib))}; two at once ${await med(()=>Promise.all([h(mib),h(mib)]))}`)})()'
```

### B2. The Cloudflare rule

From the workstation. Expect about 10 answers from the api first (Cloudflare counts approximately and per data centre): `403 application/json` from its CSRF check, because `curl` sends no `Origin` or `Sec-Fetch-Site`, so no request reaches a route or the api's limiter. Then Cloudflare's `429 text/plain`. 25 × 403 means the rule did not fire: check that its expression covers the whole path ("URI Path starts with `/api/v1/auth/`", or a wildcard match; "equals `/api/v1/auth/*`" takes the `*` literally) and that it is deployed.

```bash
time (for i in $(seq 25); do curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X POST -H 'content-type: application/json' --data '{}' https://<domain>/api/v1/auth/code; done | uniq -c)
```

**Result (2026-11-27):** 25 requests in 1.7 s: 10 × `403 application/json`, then 15 × `429 text/plain; charset=UTF-8`. A first run, before the owner checked the rule, gave 25 × 403 and no 429. The CSRF check answers before the api's limiter, so the run uses none of the per-prefix code budget.

### B3. A real mail

The first-admin sign-up above is the real code mail. In it, `Authentication-Results` should show spf, dkim and dmarc `pass`, and the source should have no `<img>` and no rewritten link.

### B4. The tunnel lengths

In the browser console on `https://<domain>/account`, signed in within the last 10 minutes. The api's request log records each request's body framing as a fixed code. Send:

- `POST /api/v1/auth/code` with `{"x":1}`: expect 400 with `fields`;
- `PUT /api/v1/me/password` with `{"x":1}`: expect 400 with `fields`;
- a body-less `POST /api/v1/auth/signout`: expect 204;
- a `ReadableStream` body with `duplex: 'half'`: expect 400 with `fields: []` if it arrives chunked.

Then paste the `body` field of each line of:

```bash
mjkc logs --since 10m --no-log-prefix api | grep '"msg":"request"'
```

### B5. Passkeys (owner)

On the owner's phone and on a desktop browser, after the merge and deploy:

1. Sign in by code, then add a platform passkey on the account page (within 5 minutes of signing in).
   The account's mailbox gets the notice "A passkey was added to your … account" ("Er is een passkey toegevoegd …"): fixed text, no passkey name, no link.
2. Sign out, then sign in with it: the button and, where the browser offers it, the autofill list in the email field.
3. Check that the session list shows "Passkey", rename the passkey, then remove it (this signs out the other sessions).
4. Confirm that the removed passkey no longer signs in.
   Before removing it, wait 11 minutes (or sign in on a session older than 10 minutes) and try a change that needs "confirm it's you" (e.g. set a password): the panel offers "Confirm with a passkey" and lists only this account's passkeys; confirming with it lets the change through.
5. Once on `admin.<domain>` too: the same passkey works there, only for the Access JWT's email.

The result goes into the PR as the [owner] criterion.

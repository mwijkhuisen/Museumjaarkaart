# Runbook: accounts (P2a)

For the owner. The operator's view of sign-in, invites and the first admin, and the [box] checks to run after the P2a merge. The code wins where this text differs: report the difference.

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

## 1. Secrets and the deploy order

`app_keys` (63012) and `lettermint_api_token` (63008): format and creation in `docs/runbooks/install.md` §4, rotation in `docs/runbooks/secrets-rotation.md` §8 and §9. The order of the P2a deploy is `docs/runbooks/update.md` §8. The worker also needs `MJK_MAIL_FROM` in `/etc/mjk/mjk.env`; without it, or without a real token, mail jobs fail as `mail_unconfigured` or `mail_refused` and no code reaches anyone.

## 2. The first admin (O4), after the deploy

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

Their results go into a follow-up docs PR.

### B1. argon2 on the VM

Run on the image already deployed. The gate allows 2 hashes at once, so each m is measured alone and as a pair (`Promise.all` of two). Keep the highest m whose single median and pair median are both under 250 ms; a follow-up PR commits it to `apps/server/src/auth/argon2.ts` and A§9. Re-run the e2e `@load` pass after it.

For that PR: `dummyVerify` runs at the current parameters, so after m goes up an unknown email answers slower than an account whose hash still has the old m, until that member signs in. Run the dummy at the old parameters too, with a test (A§9).

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

From the workstation. Expect the origin's 4xx first, then Cloudflare's 429 after 10 requests:

```bash
for i in $(seq 25); do curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'content-type: application/json' --data '{}' https://<domain>/api/v1/auth/code; done; echo
```

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

import { type Me, PasskeyList } from '@mjk/contracts';
import { useEffect, useRef, useState } from 'react';
import { getJson } from '../../lib/api.ts';
import { m } from '../../paraglide/messages.js';
import { useAction } from './errors.ts';
import { FormError } from './fields.tsx';

// "Or confirm with one of your passkeys" in the "confirm it's you" panel (P2b; A§9). Client only:
// the library is a lazy chunk (lib/passkey.ts), so the server render and the first client render
// show nothing. The section appears only where the browser can do WebAuthn and the member has at
// least one passkey; on any failure of that check it stays hidden and the code form is all there
// is. The server answers with a new session (a cookie) and `Me`: the same as after a code.

type Lib = typeof import('../../lib/passkey.ts');

export function PasskeyReauth({ onDone }: { onDone: (me: Me) => void }) {
  const [available, setAvailable] = useState(false);
  const { busy, failure, run } = useAction('passkey_reauth');
  const lib = useRef<Lib | null>(null);
  const callback = useRef(onDone);
  callback.current = onDone;

  useEffect(() => {
    // Effects never run on the server; the constant lets the SSR build drop the chunk too.
    if (import.meta.env.SSR) return;
    let live = true;
    import('../../lib/passkey.ts')
      .then(async (loaded) => {
        lib.current = loaded;
        if (!(await loaded.support()).webauthn) return;
        const { items } = await getJson('/api/v1/me/passkeys', PasskeyList);
        if (live && items.length > 0) setAvailable(true);
      })
      .catch(() => {});
    return () => {
      live = false;
      // The panel went away (cancelled, or confirmed another way): the ceremony in flight ends too.
      lib.current?.cancel();
    };
  }, []);

  if (!available) return null;
  const confirm = () => {
    const loaded = lib.current;
    if (loaded === null) return;
    void run(async () => {
      callback.current(await loaded.reauthenticate());
    });
  };
  return (
    <div className="stack">
      <p>{m.reauth_passkey_intro()}</p>
      <FormError failure={failure} />
      <div>
        <button type="button" className="button" disabled={busy} onClick={confirm}>
          {m.action_reauth_passkey()}
        </button>
      </div>
    </div>
  );
}

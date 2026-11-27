import { createElement, useEffect, useRef, useState } from 'react';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';

// The ALTCHA widget (A§9, A§15.5): an invisible-in-effect proof of work, solved on load with no
// puzzle for the person (WCAG 3.3.8). The code, its stylesheet and its worker are a lazy chunk
// (altcha-load.ts); until the effect has loaded it, the server render and the first client render
// show nothing but a status line, so hydration matches.

type Widget = HTMLElement & { verify(): Promise<unknown> };

/** Every string the widget reads, from our messages in the page's language (`footer` and the link label are unused: no footer, no logo). */
const strings = (): Record<string, string> => ({
  ariaLinkLabel: '',
  cancel: m.altcha_cancel(),
  enterCode: m.altcha_enter_code(),
  enterCodeAria: m.altcha_enter_code_aria(),
  enterCodeFromImage: m.altcha_enter_code_from_image(),
  error: m.altcha_error(),
  expired: m.altcha_expired(),
  footer: '',
  getAudioChallenge: m.altcha_get_audio_challenge(),
  label: m.altcha_label(),
  loading: m.altcha_loading(),
  reload: m.altcha_reload(),
  verify: m.altcha_verify(),
  verificationRequired: m.altcha_verification_required(),
  verified: m.altcha_verified(),
  verifying: m.altcha_verifying(),
  waitAlert: m.altcha_wait_alert(),
});

type Props = {
  locale: Locale;
  /** The payload once solved, null while it is not (and again once it expired). Single use: remount with a new `key` after a submit. */
  onPayload: (payload: string | null) => void;
};

export function Altcha({ locale, onPayload }: Props) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const widget = useRef<Widget | null>(null);
  const callback = useRef(onPayload);
  callback.current = onPayload;

  useEffect(() => {
    // Effects never run on the server; the constant lets the SSR build drop the chunk too.
    if (import.meta.env.SSR) return;
    let live = true;
    import('./altcha-load.ts').then(
      ({ registerAltcha }) => {
        registerAltcha(locale, strings());
        if (live) setReady(true);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [locale]);

  useEffect(() => {
    const el = widget.current;
    if (!ready || el === null) return;
    const onState = (event: Event) => {
      const { state, payload } = (event as CustomEvent<{ state: string; payload: string | null }>).detail;
      callback.current(state === 'verified' && payload ? payload : null);
      // A challenge lives a few minutes: solve a new one for a person who is still filling the form in.
      if (state === 'expired') void el.verify();
    };
    el.addEventListener('statechange', onState);
    return () => {
      el.removeEventListener('statechange', onState);
      callback.current(null);
    };
  }, [ready]);

  if (failed) return <p className="form-error">{m.altcha_error()}</p>;
  if (!ready) return <p className="muted">{m.altcha_loading()}</p>;
  return (
    <div className="altcha">
      {createElement('altcha-widget', {
        ref: widget,
        auto: 'onload',
        // Four workers, not one per core: the SHA-256 challenge is small, and 16 workers at once (a 16-core
        // machine) cost memory for nothing and made Chromium under Playwright lose a worker script's finish
        // event, so `networkidle` never settled (P2c).
        workers: '4',
        type: 'native',
        challenge: '/api/v1/auth/altcha',
        language: locale,
        configuration: JSON.stringify({ hideFooter: true, hideLogo: true }),
      })}
    </div>
  );
}

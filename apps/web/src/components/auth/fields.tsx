import { type InputHTMLAttributes, type ReactNode, useId } from 'react';
import type { Failure } from './errors.ts';

// Form parts (A§15.5): a visible label on every input, hints and errors tied to the input with
// aria-describedby, aria-invalid on a field with an error, 44 px targets (styles.css). No inline style.

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-describedby' | 'aria-invalid'>;

export function Field({
  label,
  hint,
  error,
  ...input
}: InputProps & { label: string; hint?: string; error?: string | undefined }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId].filter(Boolean);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint === undefined ? null : (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
      <input
        id={id}
        {...input}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy.length === 0 ? undefined : describedBy.join(' ')}
      />
      {error === undefined ? null : (
        <p id={errorId} className="field__error">
          {error}
        </p>
      )}
    </div>
  );
}

export function CheckField({
  label,
  error,
  ...input
}: Omit<InputProps, 'type'> & { label: ReactNode; error?: string | undefined }) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="check">
      <input
        id={id}
        type="checkbox"
        {...input}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
      />
      <label htmlFor={id}>{label}</label>
      {error === undefined ? null : (
        <p id={errorId} className="field__error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The form-level error: announced when it appears (role="alert"); nothing when there is no text. */
export function FormError({ failure }: { failure: Failure | null }) {
  if (failure === null || failure.text === '') return null;
  return (
    <p role="alert" className="form-error">
      {failure.text}
    </p>
  );
}

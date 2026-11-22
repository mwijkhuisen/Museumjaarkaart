/** A map failure with a fixed code (never a message that holds a URL or a response body). */
export class MapError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'MapError';
    this.code = code;
  }
}

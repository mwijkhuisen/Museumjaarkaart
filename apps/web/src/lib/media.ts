/** `https://media.<hostname>`: the one origin photos and tiles come from (the CSP's `img-src` and `connect-src`). */
export const mediaOrigin = (hostname: string): string => `https://media.${hostname}`;

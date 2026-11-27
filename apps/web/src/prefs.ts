// A classic script (no import, no export): the one thing that must run before the first paint. When this
// browser's member has "hide ratings until I've visited" on, the flag key says so and <html> gets
// `data-hide-ratings`, which the CSS reads. The key is written by lib/member.ts (`syncFold`). No inline
// script, no cookie, no personal HTML: the document is the same for everyone (A§15.1, A§15.6).
try {
  if (localStorage.getItem('mjk-hide-ratings') === '1') document.documentElement.setAttribute('data-hide-ratings', '');
} catch {}

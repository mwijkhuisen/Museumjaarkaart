// The container check of a variant the `media` role wrote (A§12, A§16.2 "A libvips exploit"; P3b security review
// M2). The decoder is assumed compromised, so a variant's magic bytes prove nothing: this walks the whole container
// and accepts exactly the structure sharp 0.35.5 (libvips 8.18.7, libwebp, libavif) writes for our pipeline, with
// the expected dimensions, and nothing else. No EXIF, XMP or ICC chunk, item or property, no animation, no second
// image, no unreferenced bytes. It decodes no pixels, so the pixels themselves stay the decoder's (A§16.2).
// Pure, no sharp: the worker and the api load it. Never throws: any doubt is false.

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** The height sharp gives a resize of a `sourceWidth × sourceHeight` image to `width` (libvips rounds; ≥ 1). */
export function expectedHeight(sourceWidth: number, sourceHeight: number, width: number): number {
  return Math.max(1, Math.round((sourceHeight * width) / sourceWidth));
}

/** True only for a WebP or AVIF of exactly sharp's structure, `width` wide and `height` (±1) high. */
export function checkVariant(bytes: Uint8Array, format: 'avif' | 'webp', width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return false;
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = (w: number, h: number) => w === width && Math.abs(h - height) <= 1;
    return format === 'webp' ? webp(bytes, v, size) : avif(bytes, v, size);
  } catch {
    return false;
  }
}

type SizeOk = (w: number, h: number) => boolean;

// WebP (RFC 9649): RIFF, then one `VP8 ` or `VP8L` chunk (the simple format), or `VP8X` (the alpha flag only),
// `ALPH` and `VP8 `. Sharp writes `VP8 ` alone, or `VP8X`+`ALPH`+`VP8 ` for an image with alpha.
function webp(b: Uint8Array, v: DataView, size: SizeOk): boolean {
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return false;
  if (v.getUint32(4, true) + 8 !== b.length) return false;
  const chunks: { type: string; at: number; len: number }[] = [];
  for (let o = 12; o < b.length; ) {
    if (o + 8 > b.length) return false;
    const len = v.getUint32(o + 4, true);
    const end = o + 8 + len + (len & 1);
    if (end > b.length) return false;
    chunks.push({ type: ascii(b, o, 4), at: o + 8, len });
    o = end;
  }
  const types = chunks.map((c) => c.type).join(',');
  const image = chunks.at(-1);
  if (image === undefined) return false;
  if (types === 'VP8X,ALPH,VP8 ') {
    const x = chunks[0] as (typeof chunks)[number];
    // The flags byte (alpha only: no ICC, EXIF, XMP or animation), 3 reserved bytes, then the canvas.
    if (x.len !== 10 || v.getUint32(x.at, true) !== 0x10) return false;
    if (!size(uint24(b, x.at + 4) + 1, uint24(b, x.at + 7) + 1)) return false;
    if ((chunks[1] as (typeof chunks)[number]).len < 1) return false;
  } else if (types !== 'VP8 ' && types !== 'VP8L') {
    return false;
  }
  return image.type === 'VP8 ' ? vp8(b, v, image.at, image.len, size) : vp8l(b, v, image.at, image.len, size);
}

const uint24 = (b: Uint8Array, at: number) =>
  (b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16);

/** A VP8 key frame: frame tag (key frame, shown), start code 9d 01 2a, 14-bit width and height, no upscaling. */
function vp8(b: Uint8Array, v: DataView, at: number, len: number, size: SizeOk): boolean {
  if (len < 10) return false;
  const tag = uint24(b, at);
  const firstPartition = tag >>> 5;
  if (
    (tag & 1) !== 0 ||
    ((tag >> 1) & 7) > 3 ||
    ((tag >> 4) & 1) !== 1 ||
    firstPartition < 1 ||
    firstPartition > len - 10
  )
    return false;
  if (b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) return false;
  const w = v.getUint16(at + 6, true);
  const h = v.getUint16(at + 8, true);
  if (w >> 14 !== 0 || h >> 14 !== 0) return false; // scaling bits
  return size(w, h);
}

/** A VP8L stream: signature 0x2f, 14-bit width − 1 and height − 1, the alpha hint, version 0. */
function vp8l(b: Uint8Array, v: DataView, at: number, len: number, size: SizeOk): boolean {
  if (len < 5 || b[at] !== 0x2f) return false;
  const bits = v.getUint32(at + 1, true);
  if (bits >>> 29 !== 0) return false;
  return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
}

// AVIF (ISO/IEC 23008-12, the AV1 image format): `ftyp` (major brand avif), `meta`, `mdat`, in that order and
// nothing else. In `meta`: hdlr `pict` (empty name), pitm, iloc, iinf, iprp (ipco, ipma) and, with alpha, iref.
// Items: one `av01`, or two where the second is the alpha auxiliary (`auxl` to the primary, an `auxC` of the alpha
// URN). Properties: av1C (no config OBUs), ispe, pixi, colr `nclx`, auxC. The items' extents tile `mdat` exactly,
// and each extent is AV1 OBUs (temporal delimiter, sequence header, frame, frame header, tile group) only.

type Box = { type: string; at: number; end: number };

/** The boxes that exactly tile [start, end); undefined when they do not. */
function boxes(b: Uint8Array, v: DataView, start: number, end: number): Box[] | undefined {
  const out: Box[] = [];
  for (let o = start; o < end; ) {
    if (o + 8 > end) return undefined;
    let len = v.getUint32(o);
    let hdr = 8;
    if (len === 1) {
      if (o + 16 > end || v.getUint32(o + 8) !== 0) return undefined;
      len = v.getUint32(o + 12);
      hdr = 16;
    }
    if (len < hdr || o + len > end) return undefined; // size 0 ("to the end") is refused too
    out.push({ type: ascii(b, o + 4, 4), at: o + hdr, end: o + len });
    o += len;
  }
  return out;
}

/** The children of a box with these exact types, once each, in any order; undefined otherwise. */
function only(list: Box[] | undefined, required: string[], optional: string[] = []): Map<string, Box> | undefined {
  if (list === undefined) return undefined;
  const m = new Map<string, Box>();
  for (const x of list) {
    if (m.has(x.type) || (!required.includes(x.type) && !optional.includes(x.type))) return undefined;
    m.set(x.type, x);
  }
  return required.every((t) => m.has(t)) ? m : undefined;
}

/** A full box's version and flags must be these. */
const full = (v: DataView, x: Box, version: number) => x.end - x.at >= 4 && v.getUint32(x.at) === version << 24;

const ALPHA_URN = 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0';
const OBU_TYPES = new Set([1, 2, 3, 4, 6]);

function avif(b: Uint8Array, v: DataView, size: SizeOk): boolean {
  const top = boxes(b, v, 0, b.length);
  if (top === undefined || top.map((x) => x.type).join(',') !== 'ftyp,meta,mdat') return false;
  const [ftyp, meta, mdat] = top as [Box, Box, Box];
  if (ascii(b, ftyp.at, 4) !== 'avif' || (ftyp.end - ftyp.at) % 4 !== 0) return false;

  if (!full(v, meta, 0)) return false;
  const kids = boxes(b, v, meta.at + 4, meta.end);
  if (kids?.[0]?.type !== 'hdlr') return false;
  const m = only(kids, ['hdlr', 'pitm', 'iloc', 'iinf', 'iprp'], ['iref']);
  if (m === undefined) return false;
  const get = (t: string) => m.get(t) as Box;

  // hdlr: pre_defined 0, `pict`, 12 reserved zero bytes, an empty name.
  const hdlr = get('hdlr');
  if (hdlr.end - hdlr.at !== 25 || !full(v, hdlr, 0) || ascii(b, hdlr.at + 8, 4) !== 'pict') return false;
  if (b.subarray(hdlr.at + 4, hdlr.at + 8).some((x) => x !== 0)) return false;
  if (b.subarray(hdlr.at + 12, hdlr.end).some((x) => x !== 0)) return false;

  // iinf (version 0) of infe version 2: flags 0, no protection, `av01`, an empty name.
  const iinf = get('iinf');
  if (!full(v, iinf, 0) || iinf.end - iinf.at < 6) return false;
  const infes = boxes(b, v, iinf.at + 6, iinf.end);
  if (infes === undefined || infes.length !== v.getUint16(iinf.at + 4) || infes.length < 1 || infes.length > 2) {
    return false;
  }
  const ids: number[] = [];
  for (const e of infes) {
    if (e.type !== 'infe' || e.end - e.at !== 13 || !full(v, e, 2)) return false;
    if (v.getUint16(e.at + 6) !== 0 || ascii(b, e.at + 8, 4) !== 'av01' || b[e.at + 12] !== 0) return false;
    const id = v.getUint16(e.at + 4);
    if (id === 0 || ids.includes(id)) return false;
    ids.push(id);
  }

  const pitm = get('pitm');
  if (pitm.end - pitm.at !== 6 || !full(v, pitm, 0)) return false;
  const primary = v.getUint16(pitm.at + 4);
  if (!ids.includes(primary)) return false;
  const aux = ids.find((id) => id !== primary);

  // iref: only with an alpha item, exactly one `auxl` from it to the primary.
  const iref = m.get('iref');
  if ((iref !== undefined) !== (aux !== undefined)) return false;
  if (iref !== undefined) {
    if (!full(v, iref, 0)) return false;
    const refs = boxes(b, v, iref.at + 4, iref.end);
    const r = refs?.[0];
    if (refs?.length !== 1 || r === undefined || r.type !== 'auxl' || r.end - r.at !== 6) return false;
    if (v.getUint16(r.at) !== aux || v.getUint16(r.at + 2) !== 1 || v.getUint16(r.at + 4) !== primary) return false;
  }

  // iprp: ipco, then ipma.
  const iprp = boxes(b, v, get('iprp').at, get('iprp').end);
  if (iprp?.length !== 2 || iprp[0]?.type !== 'ipco' || iprp[1]?.type !== 'ipma') return false;
  const props = boxes(b, v, (iprp[0] as Box).at, (iprp[0] as Box).end);
  if (props === undefined) return false;
  for (const p of props) if (!property(b, v, p, size)) return false;
  const assoc = ipma(v, iprp[1] as Box, props.length);
  if (assoc === undefined || assoc.size !== ids.length) return false;
  for (const id of ids) {
    const types = (assoc.get(id) ?? []).map((i) => (props[i - 1] as Box).type);
    const count = (t: string) => types.filter((x) => x === t).length;
    if (count('ispe') !== 1 || count('av1C') !== 1 || count('pixi') > 1 || count('colr') > 1) return false;
    if (count('auxC') !== (id === aux ? 1 : 0)) return false;
  }

  return extents(b, v, get('iloc'), ids, mdat);
}

/** One item property; false for a type or content sharp does not write. */
function property(b: Uint8Array, v: DataView, p: Box, size: SizeOk): boolean {
  const len = p.end - p.at;
  switch (p.type) {
    case 'ispe':
      return len === 12 && full(v, p, 0) && size(v.getUint32(p.at + 4), v.getUint32(p.at + 8));
    case 'av1C':
      return len === 4 && b[p.at] === 0x81; // marker 1, version 1; no config OBUs
    case 'pixi':
      return full(v, p, 0) && len >= 6 && len === 5 + (b[p.at + 4] as number);
    case 'colr':
      return len === 11 && ascii(b, p.at, 4) === 'nclx' && ((b[p.at + 10] as number) & 0x7f) === 0;
    case 'auxC':
      return full(v, p, 0) && ascii(b, p.at + 4, len - 4) === ALPHA_URN;
    default:
      return false;
  }
}

/** ipma: item id to its 1-based property indexes; undefined when malformed or an index points past ipco. */
function ipma(v: DataView, x: Box, nProps: number): Map<number, number[]> | undefined {
  if (x.end - x.at < 8) return undefined;
  const version = v.getUint8(x.at);
  const flags = v.getUint32(x.at) & 0xffffff;
  if (version > 1 || flags > 1) return undefined;
  const n = v.getUint32(x.at + 4);
  const out = new Map<number, number[]>();
  let o = x.at + 8;
  for (let i = 0; i < n; i++) {
    const idLen = version === 0 ? 2 : 4;
    if (o + idLen + 1 > x.end) return undefined;
    const id = version === 0 ? v.getUint16(o) : v.getUint32(o);
    const count = v.getUint8(o + idLen);
    o += idLen + 1;
    const list: number[] = [];
    for (let k = 0; k < count; k++) {
      if (o + (flags & 1 ? 2 : 1) > x.end) return undefined;
      const index = flags & 1 ? v.getUint16(o) & 0x7fff : v.getUint8(o) & 0x7f;
      o += flags & 1 ? 2 : 1;
      if (index < 1 || index > nProps) return undefined;
      list.push(index);
    }
    if (out.has(id)) return undefined;
    out.set(id, list);
  }
  return o === x.end ? out : undefined;
}

/** iloc (version 0 or 1, file offsets only): every item's extents together tile mdat's payload exactly. */
function extents(b: Uint8Array, v: DataView, x: Box, ids: number[], mdat: Box): boolean {
  if (x.end - x.at < 8) return false;
  const version = v.getUint8(x.at);
  if (version > 1 || (v.getUint32(x.at) & 0xffffff) !== 0) return false;
  const offSize = v.getUint8(x.at + 4) >> 4;
  const lenSize = v.getUint8(x.at + 4) & 15;
  const baseSize = v.getUint8(x.at + 5) >> 4;
  const indexSize = version === 1 ? v.getUint8(x.at + 5) & 15 : 0;
  if (![0, 4, 8].includes(offSize) || ![0, 4, 8].includes(lenSize) || ![0, 4, 8].includes(baseSize)) return false;
  if (![0, 4, 8].includes(indexSize)) return false;
  let o = x.at + 6;
  const read = (n: number): number => {
    if (o + n > x.end) throw new RangeError('iloc');
    const r = n === 0 ? 0 : n === 4 ? v.getUint32(o) : Number(v.getBigUint64(o));
    o += n;
    return r;
  };
  if (o + 2 > x.end) return false;
  const count = v.getUint16(o);
  o += 2;
  if (count !== ids.length) return false;
  const seen = new Set<number>();
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (o + 2 > x.end) return false;
    const id = v.getUint16(o);
    o += 2;
    if (version === 1) {
      if (o + 2 > x.end || (v.getUint16(o) & 15) !== 0) return false; // construction method 0: the file
      o += 2;
    }
    if (o + 2 > x.end || v.getUint16(o) !== 0) return false; // data reference index 0: this file
    o += 2;
    const base = read(baseSize);
    if (o + 2 > x.end) return false;
    const n = v.getUint16(o);
    o += 2;
    if (!ids.includes(id) || seen.has(id) || n < 1) return false;
    seen.add(id);
    for (let k = 0; k < n; k++) {
      read(indexSize);
      const off = base + read(offSize);
      const len = read(lenSize);
      if (len < 1) return false; // 0 would mean "to the end of the file"
      ranges.push([off, off + len]);
    }
  }
  if (o !== x.end) return false;
  ranges.sort((a, c) => a[0] - c[0]);
  let at = mdat.at;
  for (const [start, end] of ranges) {
    if (start !== at || end > mdat.end || !obus(b, start, end)) return false;
    at = end;
  }
  return at === mdat.end;
}

/** AV1 OBUs with size fields that tile [start, end), of the image types only (no metadata, padding, tile list). */
function obus(b: Uint8Array, start: number, end: number): boolean {
  for (let o = start; o < end; ) {
    const h = b[o] as number;
    if (h & 0x81 || !(h & 0x02)) return false; // forbidden bit, reserved bit, no size field
    if (!OBU_TYPES.has((h >> 3) & 15)) return false;
    o += h & 0x04 ? 2 : 1;
    let len = 0;
    for (let i = 0; ; i++) {
      if (i === 4 || o >= end) return false;
      const byte = b[o++] as number;
      len += (byte & 0x7f) * 2 ** (7 * i);
      if (!(byte & 0x80)) break;
    }
    o += len;
    if (o > end) return false;
  }
  return true;
}

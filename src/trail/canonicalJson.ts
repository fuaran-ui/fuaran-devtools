// ============================================================================
//  trail/canonicalJson — the wire format's canonical JSON encoding, over JSON.
//
//  WRITTEN FROM THE SPECIFICATION (`WIRE_FORMAT.md` §2), like every other
//  format-facing module here, and for a sharper reason than usual: this one is
//  BYTE-SENSITIVE. The op-stream chain hashes the canonical encoding of each
//  op, so a single reordered key or a differently-laid-out float does not
//  produce a slightly-wrong document — it produces a chain that no verifier
//  anywhere can reproduce, and it does so silently.
//
//  ── Why a JSON-in / JSON-out encoder rather than a codec dependency ────────
//
//  The published `@fuaran-ui/ops` encoder canonicalises a TYPED `TreeOp`; this
//  panel never holds one. It composes ops as structured JSON (`edit/ops`),
//  because the relay carries them as structured JSON (DEVTOOLS_RELAY §8.2).
//  Adopting the codec would mean decoding our own JSON into that package's
//  types purely to re-encode it, which pins the op vocabulary to one tier's
//  release cadence — the exact coupling this extension exists without. The
//  shape that fits is a canonicaliser over JSON values, and that is this.
//
//  ── What makes this trustworthy rather than plausible ──────────────────────
//
//  Every canonical fixture in the shared specification corpus is stored in
//  canonical BYTES. So the encoder has a fixed-point property that can be
//  checked mechanically: parse a fixture and re-encode it, and the bytes must
//  come back identical. `test/canonicalJson.test.ts` asserts that over the
//  whole `ops/` and `nodes/` corpus — 109 fixtures at the time of writing, and
//  automatically more as the format grows, because the test enumerates the
//  directory rather than a list written here.
//
//  ── The rules (WIRE_FORMAT.md §2), each with its trap ──────────────────────
//
//   1. Object keys sort by ORDINAL comparison, recursively. JavaScript's `<`
//      on strings compares UTF-16 code units, which is the same order .NET's
//      `String.CompareOrdinal` produces — so a plain comparator is correct and
//      `Array.prototype.sort`'s default (which stringifies and compares the
//      same way) would be too. `localeCompare` would NOT be: it is
//      locale-sensitive, and the document would then depend on the machine.
//      `$type` needs no special case; `$` is U+0024, below every letter.
//   2. Arrays keep source order.
//   3. Absent fields are OMITTED, never `"key":null`. An `undefined` property
//      is therefore dropped; an explicit `null` is written, because a null in
//      a JSON value the panel holds came from the format, not from absence.
//   4. Integers render bare. Floats render in .NET's `"R"` LAYOUT, which is not
//      JavaScript's: both produce the same shortest round-trip DIGITS, but .NET
//      switches to exponential outside a decimal exponent of [-4, 16] and
//      writes `1E+21` where JavaScript writes `1e+21`. `-0` collapses to `0`.
//   5. Strings escape ONLY `"`, `\`, and U+0000–U+001F (as lower-case
//      `\u00xx`). No `\n` / `\t` shortcuts, no escaped `/`, and non-ASCII
//      passes through as itself.
//   6. `NaN` / `±Infinity` render as the QUOTED strings `"NaN"`, `"Infinity"`,
//      `"-Infinity"` — JSON has no literal for them and the format chose this.
// ============================================================================

/** A JSON value, as the panel holds one. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

const BACKSLASH = String.fromCharCode(92);

/**
 * A canonical JSON string literal (rule 5).
 *
 * Iterated by code POINT (`for…of`), not code unit, so a surrogate pair passes
 * through as the one character it is rather than as two lone halves.
 */
export const encodeString = (value: string): string => {
  let out = '"';
  for (const ch of value) {
    if (ch === '"') out += `${BACKSLASH}"`;
    else if (ch === BACKSLASH) out += BACKSLASH + BACKSLASH;
    else if (ch < ' ') out += `${BACKSLASH}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
};

/** Lay significant digits out in fixed notation at decimal exponent `exponent`. */
const fixedNotation = (digits: string, exponent: number): string => {
  if (exponent < 0) return `0.${'0'.repeat(-exponent - 1)}${digits}`;
  if (digits.length > exponent + 1)
    return `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  return digits + '0'.repeat(exponent + 1 - digits.length);
};

/**
 * .NET's `"R"` layout for a finite double (rule 4).
 *
 * The DIGITS are taken from JavaScript, which already produces the shortest
 * round-tripping decimal — the same digits .NET Core produces. Only the LAYOUT
 * is re-derived: fixed notation while the decimal exponent is within
 * [-4, 16], otherwise `<mantissa>E±<at least two digits>` with an uppercase
 * `E` and an always-present sign.
 */
export const formatDouble = (value: number): string => {
  const rendered = String(value);
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(rendered);
  if (parts === null) return rendered;

  const sign = parts[1] ?? '';
  const integerPart = parts[2] ?? '0';
  const fractionPart = parts[3] ?? '';
  const jsExponent = Number(parts[4] ?? '0');

  const allDigits = integerPart + fractionPart;
  const firstSignificant = allDigits.search(/[1-9]/);
  if (firstSignificant < 0) return `${sign}0`;

  const digits = allDigits.slice(firstSignificant).replace(/0+$/, '') || '0';
  const exponent = integerPart.length - 1 - firstSignificant + jsExponent;

  if (exponent >= -4 && exponent <= 16) return sign + fixedNotation(digits, exponent);

  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${mantissa}E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
};

/** A canonical JSON number (rules 4 and 6). */
export const encodeNumber = (value: number): string => {
  if (Number.isNaN(value)) return '"NaN"';
  if (!Number.isFinite(value)) return value > 0 ? '"Infinity"' : '"-Infinity"';
  // Negative zero collapses: the format has one zero, and `-0` would make two
  // documents that mean the same thing hash differently.
  if (Object.is(value, -0)) return '0';
  // Integral magnitudes up to 2^53 render bare, which is both the integer rule
  // and the fixed-notation branch of the float rule — they agree here.
  if (Number.isInteger(value) && Math.abs(value) <= 1e16) return String(value);
  return formatDouble(value);
};

/**
 * The canonical bytes of a JSON value.
 *
 * Total: a value this cannot classify (a function, a symbol) renders as `null`
 * rather than throwing. Nothing the panel composes can produce one — the ops
 * come from `edit/ops` and the snapshots from the relay — and a throw here
 * would take down an export over a value that no verifier would have read.
 */
export const canonicalJson = (value: JsonValue | undefined): string => {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return encodeNumber(value);
    case 'string':
      return encodeString(value);
    case 'object':
      break;
    default:
      return 'null';
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as { readonly [key: string]: JsonValue | undefined };
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((key) => `${encodeString(key)}:${canonicalJson(record[key])}`).join(',')}}`;
};

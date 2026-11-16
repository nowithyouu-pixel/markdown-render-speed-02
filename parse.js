// A fast drop-in replacement for marked 18.1.3 with its default options
// (GitHub Flavored Markdown on, breaks off). parse(markdown) returns the
// exact HTML string marked renders for the same input. Dependency-free,
// no caching between calls: every parse is computed from scratch.

const WS = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const isDigit = (c) => c >= 48 && c <= 57;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = (c) => isAlpha(c) || isDigit(c);
// ASCII punctuation (CommonMark's set).
const isAsciiPunct = (c) =>
  (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
const punctCache = new Map();
function isPunctCh(ch) {
  let v = punctCache.get(ch);
  if (v === undefined) {
    const c = ch.codePointAt(0);
    v = isAsciiPunct(c) || /\p{P}|\p{S}/u.test(ch);
    punctCache.set(ch, v);
  }
  return v;
}
const isUnicodeWS = (c) =>
  WS(c) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
  c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;

// Escape with every & escaped (code spans, code blocks, GFM autolink text/href).
const ESC_ENCODE_RE = /[&<>"']/g;
function escEncode(s) {
  return s.replace(ESC_ENCODE_RE, (m) =>
    m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : m === '"' ? '&quot;' : '&#39;');
}
// Escape < > " ' always, and & only when it does not start something that
// looks like an entity reference (&word; &#123; &#x1f;). Used for text,
// hrefs, titles and fence info strings: marked leaves such sequences alone.
const ESC_NOENC_RE = /[<>"']|&(?!(?:#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;))/g;
function escNoEncode(s) {
  return s.replace(ESC_NOENC_RE, (m) =>
    m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : m === '"' ? '&quot;' : '&#39;');
}

// marked's URL cleaning: encodeURI, then restore %25 back to % so already
// encoded sequences survive. Returns null when encodeURI throws.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Link label normalisation: collapse runs of space/tab/newline to one
// space, trim, lowercase.
function normalizeLabel(s) {
  // Unicode case folding: ß and ẞ both fold to "ss".
  return s.replace(/[ \t\n\r]+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Decode one numeric character reference starting at s[i] === '&'.
// Returns [decodedString, endIndex] or null when it is not a valid one.
// Only &#<1-7 digits>; and &#[xX]<1-6 hex>; are recognised; 0 and the
// surrogates become U+FFFD, a value above 0x10FFFF also becomes U+FFFD.
function numericEntity(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null; // '#'
  let j = i + 2;
  let hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const start = j;
  const max = hex ? 6 : 7;
  let val = 0;
  let n = 0;
  while (n < max) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    if (d < 0) break;
    val = val * (hex ? 16 : 10) + d;
    j++;
    n++;
  }
  if (n === 0 || s.charCodeAt(j) !== 59) return null; // ';'
  if (val === 0 || val > 0x10ffff || (val >= 0xd800 && val <= 0xdfff)) return ['\ufffd', j + 1];
  return [String.fromCodePoint(val), j + 1];
}

// The code point ending just before index i (a full surrogate pair when
// there is one); '\n' at the start of the string. Same for charAfter.
function charBefore(s, i) {
  if (i <= 0) return '\n';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
function charAfter(s, j) {
  if (j >= s.length) return '\n';
  const c = s.charCodeAt(j);
  if (c >= 0xd800 && c <= 0xdbff && j + 1 < s.length) {
    const lo = s.charCodeAt(j + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return s.slice(j, j + 2);
  }
  return s[j];
}

// Can a delimiter run of ch at [a, b) open / close emphasis?
function delimCaps(ch, s, a, b) {
  const before = charBefore(s, a);
  const after = charAfter(s, b);
  const bWS = isUnicodeWS(before.codePointAt(0));
  const aWS = isUnicodeWS(after.codePointAt(0));
  const bP = isPunctCh(before);
  const aP = isPunctCh(after);
  const left = !aWS && (!aP || bWS || bP);
  const right = !bWS && (!bP || aWS || aP);
  if (ch === '_') return [left && (!right || bP), right && (!left || aP)];
  return [left, right];
}

// Backslash escapes: \ + ASCII punctuation becomes the punctuation.
const UNESC_RE = /\\([!-/:-@\[-`{-~])/g;
function unescapeBackslash(s) {
  return s.replace(UNESC_RE, '$1');
}

// Skip spaces, tabs and line endings.
function skipInlineWs(s, p) {
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10 || c === 13) p++;
    else break;
  }
  return p;
}

// Parse a <...> destination starting at s[p] === '<'.
// Returns {dest, end} (end is just past '>') or null.
function parseAngleDest(s, p) {
  let j = p + 1;
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) return { dest: s.slice(p + 1, j), end: j + 1 }; // '>'
    if (c === 10 || c === 60) return null; // newline or '<'
    if (c === 92) { // backslash: an escaped char cannot end the destination
      const nx = s.charCodeAt(j + 1);
      if (nx !== undefined && isAsciiPunct(nx)) { j += 2; continue; }
    }
    j++;
  }
  return null;
}

// Parse a bare destination starting at p. Returns {dest, end} or null.
// Stops at whitespace or an unmatched ')'; a control character anywhere
// makes the whole destination invalid.
function parseBareDest(s, p) {
  let depth = 0;
  let j = p;
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13) break;
    if (c < 32) return null;
    if (c === 92) {
      const nx = s.charCodeAt(j + 1);
      if (nx !== undefined && isAsciiPunct(nx)) { j += 2; continue; }
      j++;
      continue;
    }
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--;
      j++;
      continue;
    }
    j++;
  }
  if (j === p) return null;
  return { dest: s.slice(p, j), end: j };
}

// Parse a link title starting at p ("...", '...', or (...)).
// Returns {title, end} or null. Backslash escapes inside are resolved.
function parseTitle(s, p) {
  const c = s.charCodeAt(p);
  if (c === 34 || c === 39) { // " or '
    const q = s[p];
    let j = p + 1;
    let out = '';
    let last = p + 1;
    const n = s.length;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 92) {
        const nx = s.charCodeAt(j + 1);
        if (nx !== undefined && isAsciiPunct(nx)) {
          out += s.slice(last, j) + s[j + 1];
          j += 2;
          last = j;
          continue;
        }
        j++;
        continue;
      }
      if (s[j] === q) {
        out += s.slice(last, j);
        return { title: out, end: j + 1 };
      }
      j++;
    }
    return null;
  }
  if (c === 40) { // ( ... ) with no nesting
    let j = p + 1;
    const n = s.length;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 92) {
        const nx = s.charCodeAt(j + 1);
        if (nx !== undefined && isAsciiPunct(nx)) { j += 2; continue; }
        j++;
        continue;
      }
      if (s[j] === ')') return { title: unescapeBackslash(s.slice(p + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Try an inline link (dest "title") starting at s[p] === '('.
// Returns {href, title, end} or null.
function tryInlineLink(s, p) {
  let q = skipInlineWs(s, p + 1);
  const hadWs = q > p + 1;
  // An empty destination: '()' or '( "title")'.
  if (s.charCodeAt(q) === 41) return { href: '', title: null, end: q + 1 };
  let destRes = null;
  if (s.charCodeAt(q) === 60) {
    destRes = parseAngleDest(s, q);
    if (!destRes) return null;
  } else if (hadWs && (s.charCodeAt(q) === 34 || s.charCodeAt(q) === 39 || s.charCodeAt(q) === 40)) {
    // A quote right after whitespace means an empty destination and
    // a title; without the whitespace it is a bare destination that
    // happens to start with a quote.
    destRes = { dest: '', end: q };
  } else {
    destRes = parseBareDest(s, q);
    if (!destRes) return null;
  }
  const href = cleanUrl(unescapeBackslash(destRes.dest));
  if (href === null) return null;
  q = skipInlineWs(s, destRes.end);
  let title = null;
  const qc = s.charCodeAt(q);
  if (qc === 34 || qc === 39 || qc === 40) {
    const t = parseTitle(s, q);
    if (t) {
      title = t.title;
      q = skipInlineWs(s, t.end);
    }
    // A title that fails to parse leaves q on the quote: the ')' check
    // below then fails, so the whole link fails.
  }
  if (s.charCodeAt(q) !== 41) return null; // ')'
  return { href, title, end: q + 1 };
}

// Whether a link label's backticks are balanced per marked's label
// pattern: a backtick run must either be followed by another run
// (any length) with no backtick between them (the code-span
// alternative, which does not require matching run lengths), or sit
// at the very end of the label (the ``+(?=]) alternative). A lone
// run with no later run invalidates the label, so no link forms
// (e.g. `[empty test `a ` b` output](...)` — the third backtick has
// no partner). Escaped backticks do not count.
function labelBackticksOk(label) {
  const n = label.length;
  let j = 0;
  while (j < n) {
    if (label[j] === '\\') { j += 2; continue; }
    if (label[j] !== '`') { j++; continue; }
    let e = j;
    while (e < n && label[e] === '`') e++;
    // A run at the very end of the label is allowed only when it
    // has two or more backticks (marked's ``+(?=]) alternative is
    // `` + `+`, i.e. 2+ backticks); a single trailing backtick
    // invalidates the label.
    if (e === n) return e - j >= 2;
    let k = e;
    while (k < n && label[k] !== '`') k++;
    if (k >= n) return false;
    let m = k;
    while (m < n && label[m] === '`') m++;
    j = m;
  }
  return true;
}

// End of a link label starting just after '['. -1 when the label is
// invalid (contains an unescaped '[') or runs off the end.
function findLabelEnd(s, p) {
  const n = s.length;
  for (let j = p; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) { j++; continue; } // backslash escapes the next char
    if (c === 93) return j; // ']'
    if (c === 91) return -1; // '['
  }
  return -1;
}

// Try a reference link starting just after ']'. linkText is the raw text
// between the brackets. Returns {href, title, end} or null.
function tryRefLink(s, p, linkText, defs) {
  if (s.charCodeAt(p) === 91) { // '[' label ']'
    const close = findLabelEnd(s, p + 1);
    if (close < 0) return null;
    const raw = s.slice(p + 1, close);
    let label;
    if (raw.length === 0) {
      label = normalizeLabel(linkText);
      if (label.length === 0 || label.length > 999 || linkText.includes('[')) return null;
    } else {
      if (raw.length > 999) return null;
      label = normalizeLabel(raw);
    }
    const def = defs.get(label);
    if (!def) return null;
    return { href: def.href, title: def.title, end: close + 1 };
  }
  const label = normalizeLabel(linkText);
  if (label.length === 0 || label.length > 999 || linkText.includes('[')) return null;
  const def = defs.get(label);
  if (!def) return null;
  return { href: def.href, title: def.title, end: p };
}

// Full atext (CommonMark's email local-part set) for <...> autolinks.
function isAtext(c) {
  return isAlnum(c) || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 45 || c === 46 || c === 47 || c === 61 || c === 63 ||
    c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126;
}
// GFM bare-email local part: only alnum and . + - _
function isGfmLocal(c) {
  return isAlnum(c) || c === 46 || c === 43 || c === 45 || c === 95;
}
// GFM bare-email domain label character.
function isGfmDomain(c) {
  return isAlnum(c) || c === 95 || c === 45;
}

// Validate a GFM bare email starting at start; return its end or -1.
// Local part [A-Za-z0-9.+_-]+, domain labels [A-Za-z0-9_-]+ separated by
// '.', at least two labels, and the last label must end in an
// alphanumeric (marked's domain pattern is [A-Za-z0-9-_]+ followed by
// one or more '.' + [A-Za-z0-9-_]*[A-Za-z0-9]). A label may end in
// '_'/'-' only when a '.' follows it directly.
function scanEmailGfm(s, start) {
  const n = s.length;
  let j = start;
  while (j < n && isGfmLocal(s.charCodeAt(j))) j++;
  if (j === start || s.charCodeAt(j) !== 64) return -1; // '@'
  j++;
  const ls0 = j;
  while (j < n && isGfmDomain(s.charCodeAt(j))) j++;
  if (j === ls0) return -1;
  let labels = 1;
  let domainEnd = -1;
  while (s.charCodeAt(j) === 46) {
    let k = j + 1;
    let lastAlnum = -1;
    while (k < n && isGfmDomain(s.charCodeAt(k))) {
      if (isAlnum(s.charCodeAt(k))) lastAlnum = k;
      k++;
    }
    if (lastAlnum < 0) break;
    labels++;
    domainEnd = lastAlnum + 1;
    j = domainEnd;
  }
  if (labels < 2 || domainEnd < 0) return -1;
  return domainEnd;
}

// Validate an <...> email: the content s[start..end) must be exactly one
// email. Local part is full atext; domain labels are [A-Za-z0-9] with
// [A-Za-z0-9-]* inside and no underscore anywhere in the domain.
function scanEmailAngle(s, start, end) {
  let j = start;
  while (j < end && isAtext(s.charCodeAt(j))) j++;
  if (j === start || j >= end || s.charCodeAt(j) !== 64) return false;
  j++;
  let labels = 0;
  while (true) {
    if (j >= end || !isAlnum(s.charCodeAt(j))) return false;
    j++;
    while (j < end) {
      const c = s.charCodeAt(j);
      if (isAlnum(c) || c === 45) j++;
      else break;
    }
    if (!isAlnum(s.charCodeAt(j - 1))) return false;
    labels++;
    if (j < end && s.charCodeAt(j) === 46) { j++; continue; }
    break;
  }
  if (labels < 2) return false;
  return j === end;
}

// Try an <...> autolink at s[i] === '<'. Returns {href, text, end} or null.
function tryAngleAutolink(s, i) {
  const n = s.length;
  let gt = -1;
  for (let j = i + 1; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 62) { gt = j; break; }
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) return null;
  }
  if (gt < 0) return null;
  const cand = s.slice(i + 1, gt);
  const colon = cand.indexOf(':');
  if (colon > 0) {
    const scheme = cand.slice(0, colon);
    if (scheme.length >= 2 && scheme.length <= 32 && isAlpha(scheme.charCodeAt(0))) {
      let ok = true;
      for (let k = 1; k < scheme.length; k++) {
        const c = scheme.charCodeAt(k);
        if (!isAlnum(c) && c !== 43 && c !== 45 && c !== 46) { ok = false; break; }
      }
      if (ok) {
        const href = cleanUrl(cand);
        if (href !== null) return { href, text: cand, end: gt + 1 };
      }
    }
  }
  if (scanEmailAngle(s, i + 1, gt)) {
    return { href: 'mailto:' + cand, text: cand, end: gt + 1 };
  }
  return null;
}

// Parse a raw HTML tag starting at s[i] === '<'. Returns the index just
// past '>' or -1 when it is not a tag.
function parseInlineTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    // "<!-->" and "<!--->" are complete (empty) comments by themselves.
    if (s.charCodeAt(i + 4) === 62) return i + 5;
    if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
    const e = s.indexOf('-->', i + 4);
    return e >= 0 ? e + 3 : -1;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    return e >= 0 ? e + 2 : -1;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    return e >= 0 ? e + 3 : -1;
  }
  if (s.startsWith('<!', i) && isAlpha(s.charCodeAt(i + 2))) {
    const e = s.indexOf('>', i + 2);
    return e >= 0 ? e + 1 : -1;
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (!isAlpha(s.charCodeAt(j))) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 45) j++;
    else break;
  }
  if (closing) {
    let k = j;
    while (k < n && WS(s.charCodeAt(k))) k++;
    return s.charCodeAt(k) === 62 ? k + 1 : -1;
  }
  while (true) {
    let k = j;
    while (k < n && WS(s.charCodeAt(k))) k++;
    if (k >= n) return -1;
    const c = s.charCodeAt(k);
    if (c === 62) return k + 1; // '>'
    if (c === 47) return s.charCodeAt(k + 1) === 62 ? k + 2 : -1; // '/>'
    if (k === j) return -1; // an attribute needs preceding whitespace
    if (!isAlpha(c) && c !== 95 && c !== 58) return -1; // attribute name
    let m = k + 1;
    while (m < n) {
      const d = s.charCodeAt(m);
      if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) m++;
      else break;
    }
    let q = m;
    while (q < n && WS(s.charCodeAt(q))) q++;
    if (s.charCodeAt(q) === 61) { // '=' value
      q++;
      while (q < n && WS(s.charCodeAt(q))) q++;
      const vc = s.charCodeAt(q);
      if (vc === 34 || vc === 39) {
        const quote = s[q];
        let r = q + 1;
        while (r < n && s[r] !== quote) r++;
        if (r >= n) return -1;
        q = r + 1;
      } else {
        let r = q;
        while (r < n) {
          const d = s.charCodeAt(r);
          if (d === 32 || d === 9 || d === 10 || d === 13 || d === 34 || d === 39 ||
              d === 61 || d === 60 || d === 62 || d === 96) break;
          r++;
        }
        if (r === q) return -1;
        q = r;
      }
      j = q;
    } else {
      // No value: the attribute ends at the name, and the whitespace
      // after it separates it from the next attribute.
      j = m;
    }
  }
}

// Scan a GFM autolink URL starting at i and trim its trailing punctuation,
// entity-like suffix and unbalanced ')'. Returns the end index.
// Marked's _backpedal for GFM autolinks: the URL is the longest
// prefix of the scanned candidate segmentable into runs of
// non-trailing-punctuation, balanced (...) groups, lone &s, and
// trailing-punctuation runs that are not at the very end (applied
// until stable, so trailing punctuation is trimmed iteratively).
const GFM_URL_BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function scanGfmUrl(s, i, bracketActive, defs) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    // Marked's url pattern stops only at whitespace and '<'; a '>'
    // is part of the URL.
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
    // Inside an active bracket, a ']' that would close the bracket
    // and start a link destination (or a defined ref label) ends the
    // URL: the link parser gets priority, as in marked (link is tried
    // before url). A ']' followed by anything else stays part of the
    // URL; an inactive bracket cannot form a link, so its ']' does
    // not end the URL either.
    if (bracketActive && c === 93) {
      const nx = s[j + 1];
      if (nx === '(') break;
      if (nx === '[') {
        const cb = s.indexOf(']', j + 2);
        if (cb > j + 2 && defs && defs.get(normalizeLabel(s.slice(j + 2, cb)))) break;
      }
    }
    j++;
  }
  let cand = s.slice(i, j);
  let prev;
  do {
    prev = cand;
    const m = GFM_URL_BACKPEDAL.exec(cand);
    cand = m ? m[0] : '';
  } while (cand !== prev);
  return i + cand.length;
}

// The character before a www/http/ftp autolink must be the start of the
// string, whitespace, or one of ( ~ * _
function gfmBoundary(s, i) {
  if (i === 0) return true;
  const c = s[i - 1];
  return isUnicodeWS(c.charCodeAt(0)) || c === '(' || c === '~' || c === '*' || c === '_';
}

// Does the delimiter run at pos (ch, n, canOpen, canClose) have a partner
// among the already-emitted delimiters? Used to keep an email autolink
// from swallowing a '_' that belongs to an emphasis pair.
function hasDelimPartner(pos, ch, n, canOpen, canClose, parts, srcs, delims) {
  for (let k = 0; k < delims.length; k++) {
    const di = delims[k];
    const d = parts[di];
    if (d[1] !== ch) continue;
    const p2 = srcs[di];
    if (p2 === pos) continue;
    const n2 = d[2];
    const odd = (n + n2) % 3 === 0 && !(n % 3 === 0 && n2 % 3 === 0);
    if (canOpen && p2 > pos && d[4] && !odd) return true;
    if (canClose && p2 < pos && d[3] && !odd) return true;
  }
  return false;
}

// Remove (or truncate) the parts at the end of the parts list whose source
// starts at or after `from`, and drop their delimiter entries. Used when a
// GFM email absorbs text (and '_' delimiters) that was already emitted.
function absorbRange(parts, srcs, delims, from) {
  while (parts.length > 0) {
    const idx = parts.length - 1;
    const p = parts[idx];
    const psrc = srcs[idx];
    if (psrc >= from) {
      if (p[0] === 1) {
        const di = delims.indexOf(idx);
        if (di >= 0) delims.splice(di, 1);
      }
      parts.pop();
      srcs.pop();
    } else if (p[0] === 0 && psrc + p[1].length > from) {
      p[1] = p[1].slice(0, from - psrc);
      if (p[1].length === 0) { parts.pop(); srcs.pop(); }
      break;
    } else {
      break;
    }
  }
}

// Try a GFM bare email whose '@' is at atPos. `start` is the current text
// run start. Returns {linkStart, end, href, text} or null. Absorbs the
// local part (including '_' delimiters) out of the already-emitted parts.
function tryGfmEmail(s, atPos, parts, srcs, delims, start) {
  let localStart = atPos;
  while (localStart > 0 && isGfmLocal(s.charCodeAt(localStart - 1))) localStart--;
  if (localStart === atPos) return null;
  // A local-part character preceded by an odd run of backslashes is an
  // escaped literal, not part of the email: drop it (the email then
  // starts after it, or does not exist if nothing is left).
  let bs = 0;
  let b = localStart - 1;
  while (b >= 0 && s.charCodeAt(b) === 92) { bs++; b--; }
  if (bs % 2 === 1) {
    localStart++;
    if (localStart === atPos) return null;
  }
  // The local part must not absorb a delimiter run that actually
  // forms emphasis: marked lexes the emphasis first, so the email
  // starts after such a run (e.g. the `__` in `__because@x.com__`
  // is the emphasis opener, not part of the address). A `_` run
  // with no partner (intraword, as in `foo_bar@x.com`, or an
  // opener whose closer never comes, as in `__foo__bar@x.com`)
  // stays part of the address. Take the rightmost run the lookback
  // crossed that has a complementary run (a later run that can
  // close it, or an earlier emitted run that can open it) and
  // restart the local part just after it.
  // Simulate the emphasis scan's m accounting (marked's emStrong):
  // m starts at the opener's length, opener-only runs add, closers
  // subtract (rule-of-3 skips are ignored instead). A pair forms
  // only when some closer brings m to <= 0. A bare "a later run can
  // close" check over-triggers: an intervening opener-only run
  // inflates m so the opener never pairs (e.g. `__foo@x.com and
  // __bar__` — the opener before `foo` never pairs, so the email
  // includes it).
  const scanFrom = (opStart, opEnd, opCanClose, limit) => {
    let m = opEnd - opStart;
    const y = m;
    let j = opEnd;
    while (j < limit) {
      if (s[j] !== '_') { j++; continue; }
      let e = j;
      while (e < s.length && s[e] === '_') e++;
      const caps = delimCaps('_', s, j, e);
      const len = e - j;
      if (!caps[0] && !caps[1]) { j = e; continue; }
      if (!caps[1]) { m += len; j = e; continue; }
      const amb = caps[0] && caps[1];
      if (amb || opCanClose) {
        if (y % 3 !== 0 && (y + len) % 3 === 0) { j = e; continue; }
      }
      m -= len;
      if (m <= 0) return true;
      j = e;
    }
    return false;
  };
  const hasPartner = (runStart, runEnd, canOpen, canClose) => {
    if (canClose) {
      // This run is a closer: some earlier emitted opener must pair
      // with it. Simulate each earlier opener's scan up to this run;
      // it pairs only if this run brings m to <= 0 (and no earlier
      // closer already consumed the opener).
      for (let k = 0; k < delims.length; k++) {
        const di = delims[k];
        const p = parts[di];
        if (p[1] !== '_' || srcs[di] >= runStart) continue;
        if (!p[3]) continue;
        let m = p[5];
        const y = p[5];
        let j = srcs[di] + p[5];
        let consumed = false;
        while (j < runStart) {
          if (s[j] !== '_') { j++; continue; }
          let e = j;
          while (e < s.length && s[e] === '_') e++;
          const caps = delimCaps('_', s, j, e);
          const len = e - j;
          if (!caps[0] && !caps[1]) { j = e; continue; }
          if (!caps[1]) { m += len; j = e; continue; }
          const amb = caps[0] && caps[1];
          if (amb || p[4]) {
            if (y % 3 !== 0 && (y + len) % 3 === 0) { j = e; continue; }
          }
          m -= len;
          if (m <= 0) { consumed = true; break; }
          j = e;
        }
        if (consumed) continue;
        const len = runEnd - runStart;
        const amb = canOpen && canClose;
        if (amb || p[4]) {
          if (y % 3 !== 0 && (y + len) % 3 === 0) continue;
        }
        if (m - len <= 0) return true;
      }
      return false;
    }
    if (canOpen) return scanFrom(runStart, runEnd, canClose, s.length);
    return false;
  };
  for (let k = delims.length - 1; k >= 0; k--) {
    const di = delims[k];
    const p = parts[di];
    const ps = srcs[di];
    if (ps < localStart) break;
    if (ps >= atPos || p[1] !== '_') continue;
    if ((!p[3] && !p[4]) || !hasPartner(ps, ps + p[5], p[3], p[4])) continue;
    localStart = ps + p[5];
    if (localStart === atPos) return null;
    break;
  }
  const emailEnd = scanEmailGfm(s, localStart);
  if (emailEnd < 0) return null;
  // Marked's email pattern ends with (?![\w-]): a '_' or '-' right
  // after the domain blocks the email. Exception: a '_' run that is
  // the closer of an emphasis span containing the email (in marked
  // the email is lexed inside the span's inner text, where the
  // closer is absent) still lets the email link.
  if (emailEnd < s.length) {
    const c = s.charCodeAt(emailEnd);
    if (c === 95 || c === 45) {
      let ok = false;
      if (c === 95) {
        let k = emailEnd;
        while (k < s.length && s[k] === '_') k++;
        if (delimCaps('_', s, emailEnd, k)[1]) {
          for (let m = 0; m < delims.length; m++) {
            const di = delims[m];
            const p = parts[di];
            if (p[1] === '_' && srcs[di] < emailEnd && p[3]) { ok = true; break; }
          }
        }
      }
      if (!ok) return null;
    }
  }
  let linkStart = localStart;
  let href = null;
  if (localStart >= 7 && s.slice(localStart - 7, localStart) === 'mailto:') {
    const b = localStart - 7;
    if (b === 0 || !isAlnum(s.charCodeAt(b - 1))) { linkStart = b; href = s.slice(b, emailEnd); }
  } else if (localStart >= 5 && s.slice(localStart - 5, localStart) === 'xmpp:') {
    const b = localStart - 5;
    if (b === 0 || !isAlnum(s.charCodeAt(b - 1))) { linkStart = b; href = s.slice(b, emailEnd); }
  }
  if (href === null) href = 'mailto:' + s.slice(localStart, emailEnd);
  // An xmpp address may carry a "/resource" suffix (one path segment).
  let end = emailEnd;
  if (href.startsWith('xmpp:') && s.charCodeAt(end) === 47) {
    let r = end + 1;
    while (r < s.length) {
      const c = s.charCodeAt(r);
      if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 47) break;
      r++;
    }
    if (r > end + 1) { end = r; href = s.slice(linkStart, end); }
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return null;
  for (let k = parts.length - 1; k >= 0; k--) {
    if (srcs[k] < localStart) break;
    const p = parts[k];
    if (p[0] === 1 && p[1] === '_') {
      if (hasDelimPartner(srcs[k], '_', p[2], p[3], p[4], parts, srcs, delims)) return null;
    }
  }
  absorbRange(parts, srcs, delims, linkStart);
  return { linkStart, end, href: cleanHref, text: s.slice(linkStart, end) };
}

// Parts (inline tokens), as small arrays:
// [0, text]            literal text (rendered with escNoEncode)
// [1, ch, n, open, close]  emphasis delimiter run
// [2, href, title, isImage, closeIdx]  link / image opener
// [3]                  link closer
// [4, image, bangIdx]  an unmatched '['
// [5]                  a '!' before a '[' that never became an image
// [6, text]            code span content
// [7, html]            raw HTML tag
// [8]                  hard line break (<br>)
// Emphasis pairing, following marked 18.1.3's emStrong/del scans
// rather than the CommonMark closer-driven stack: for each opener
// (left to right) scan forward for its closer, tracking m, the
// opener's remaining length plus opener-only runs met minus closer
// runs met, and f, the lengths of ambiguous closers skipped by the
// rule of 3. A closer pairs only when it brings m to <= 0, using
// min(b, b + m + f) of its delimiters; the tag is <em> when
// min(opener, used) is odd, <strong> when even. The inner text is
// then paired recursively, with the pair's leftover delimiters as
// the inner range's edges. An opener that finds no closer is
// retried one delimiter shorter (marked emits the first delimiter
// as text and re-lexes the rest of the run). Strikethrough scans
// the same way but only same-length runs (of 1 or 2) pair and there
// is no rule-of-3 skip.
function processEmphasis(parts, delims, linkSpans, s, srcs) {
  const opensAt = new Map();
  const closesAt = new Map();
  // Innermost link/image span containing a part, or null: a
  // delimiter pairs only with one in the same span (or none).
  const ctxOf = (pi) => {
    let best = null;
    for (let k = 0; k < linkSpans.length; k++) {
      const sp = linkSpans[k];
      if (pi > sp[0] && pi < sp[1] && (!best || sp[1] - sp[0] < best[1] - best[0])) best = sp;
    }
    return best;
  };
  const ctxCache = new Map();
  const ctx = (pi) => {
    if (!ctxCache.has(pi)) ctxCache.set(pi, ctxOf(pi));
    return ctxCache.get(pi);
  };
  // Whether marked's scan applies the rule of 3 to every candidate
  // closer for this opener: the opener can itself close, is
  // preceded by a non-space character, and is followed by
  // punctuation (or, for an asterisk, preceded by a character that
  // is neither a delimiter nor punctuation).
  const openerR = (pi) => {
    const p = parts[pi];
    const prev = charBefore(s, srcs[pi]);
    if (prev.trim() === '') return false;
    const next = charAfter(s, srcs[pi] + p[5]);
    const h = prev === '*' || prev === '_' || isPunctCh(prev);
    return isPunctCh(next) || (p[1] === '*' && !h);
  };
  // Pairs are recorded outer-first here, but renderParts emits a
  // part's opens in reverse array order and its closes in array
  // order, so each new tag goes at the front: the arrays end up
  // inner-first, which renders as opens outer-first and closes
  // inner-first.
  const record = (oi, ci, tag) => {
    let oa = opensAt.get(oi);
    if (!oa) { oa = []; opensAt.set(oi, oa); }
    oa.unshift(tag);
    let ca = closesAt.get(ci);
    if (!ca) { ca = []; closesAt.set(ci, ca); }
    ca.unshift(tag);
  };
  // Marked's RDelim first alternative skips one delimiter that
  // sits between two runs of the other emphasis character, but
  // only when the pattern starts at the very beginning of the
  // scan text: for a `*` opener, a `*` run of length 1 between a
  // `__` run and another `__` run (with no other `*`/`_`
  // delimiter in between); for a `_` opener, a `_` run of length
  // 1 between a `**` run and another `**` run. `~` runs do not
  // break the pattern. Returns the part index to skip, or -1.
  const chunkSkip = (list, li, ch) => {
    const other = ch === '*' ? '_' : '*';
    let stage = 0; // 0: want opening anchor, 1: want the skipped run, 2: want closing anchor
    for (let k = li + 1; k < list.length; k++) {
      const cp = list[k];
      const C = parts[cp];
      if (C[1] !== ch && C[1] !== other) continue; // '~' and friends are transparent here
      if (stage === 0) {
        if (C[1] !== other || C[2] !== 2) return -1;
        stage = 1;
      } else if (stage === 1) {
        if (C[1] !== ch || C[2] !== 1) return -1;
        stage = 2;
        // remember the skipped run's part index
        chunkSkip.found = cp;
      } else {
        if (C[1] !== other || C[2] < 2) return -1;
        return chunkSkip.found;
      }
    }
    return -1;
  };
  // Pair the delimiters in `list` (part indices, in order). When a
  // pair forms, its inner range (plus any leftover delimiters of
  // the pair itself, which belong to the inner text) is paired
  // first, then scanning resumes after the closer — except that a
  // leftover closer that can open is itself tried as an opener
  // afterwards.
  const processRange = (list) => {
    for (let li = 0; li < list.length; li++) {
      const op = list[li];
      const O = parts[op];
      if (O[2] <= 0 || !O[3]) continue; // spent, or cannot open
      const ch = O[1];
      const oCtx = ctx(op);
      if (ch === '~') {
        const need = O[2];
        if (need > 2) continue; // only runs of 1 or 2 form <del>
        let p = need;
        let found = -1;
        for (let cj = li + 1; cj < list.length; cj++) {
          const cp = list[cj];
          const C = parts[cp];
          if (C[1] !== '~' || C[2] !== need) continue;
          if (ctx(cp) !== oCtx) continue;
          if (!C[3] && !C[4]) continue;
          if (C[3] && !C[4]) { p += C[2]; continue; }
          p -= C[2];
          if (p > 0) continue;
          found = cp;
          break;
        }
        if (found < 0) continue;
        const C = parts[found];
        const use = Math.min(C[2], C[2] + p);
        record(op, found, 'del');
        O[2] -= need;
        C[2] -= use;
        const inner = [];
        for (let k = li + 1; k < list.length && list[k] !== found; k++) inner.push(list[k]);
        if (inner.length > 0) processRange(inner);
        li = list.indexOf(found, li);
        if (C[2] > 0 && C[3]) li--;
        continue;
      }
      // y is the opener run's length in the current text: it stays
      // fixed while failed attempts shorten the run by one.
      // attemptLen is the run length this attempt scans with; the
      // part's own remaining length O[2] is only reduced when a
      // pair consumes delimiters (a failed attempt still renders
      // its first delimiter as literal text, as marked does).
      const y = O[2];
      const R = openerR(op);
      const skipPart = chunkSkip(list, li, ch);
      let paired = false;
      let attemptLen = O[2];
      while (attemptLen > 0 && !paired) {
        const retry = attemptLen < y;
        let m = attemptLen;
        let f = 0;
        let found = -1;
        let tagSize = 1;
        let bUsed = 0;
        for (let cj = li + 1; cj < list.length; cj++) {
          const cp = list[cj];
          if (cp === skipPart) continue; // hidden by the __...*...__ chunk
          const C = parts[cp];
          if (C[1] !== ch) continue;
          if (ctx(cp) !== oCtx) continue;
          if (C[2] <= 0) continue;
          const b = C[2];
          if (!C[3] && !C[4]) continue;
          if (C[3] && !C[4]) { m += b; continue; } // opener-only
          // A closer: ambiguous runs, and every run when the opener
          // can itself close, are skipped by the rule of 3 when the
          // lengths sum to a multiple of 3 (and the opener's length
          // is not one). On a retry (the opener was shortened after
          // a failed attempt) an ambiguous candidate aborts the
          // scan outright instead.
          if ((C[3] && C[4]) || R) {
            if (retry && C[3] && C[4]) break;
            if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
          }
          m -= b;
          if (m > 0) continue;
          bUsed = Math.min(b, b + m + f);
          const minLen = Math.min(attemptLen, bUsed);
          tagSize = minLen % 2 === 1 ? 1 : 2;
          found = cp;
          break;
        }
        if (found < 0) { attemptLen--; continue; } // emit one delimiter as text, retry shorter
        const C = parts[found];
        const bOrig = C[2];
        // Of the closer run, (bUsed - tagSize) delimiters belong to
        // the inner text and (bOrig - bUsed) sit after the pair.
        const innerLen = bUsed - tagSize;
        const outerLen = bOrig - bUsed;
        record(op, found, tagSize === 2 ? 'strong' : 'em');
        const prefixLen = O[2] - attemptLen; // delimiters emitted as text before the pair
        O[2] = attemptLen - tagSize; // inner leftover only, for the recursion
        C[2] = innerLen;
        const inner = [];
        if (O[2] > 0) inner.push(op);
        for (let k = li + 1; k < list.length && list[k] !== found; k++) inner.push(list[k]);
        if (innerLen > 0) inner.push(found);
        if (inner.length > 0) processRange(inner);
        // Restore the opener's literal length: the text-emitted
        // prefix plus whatever of the inner leftover survived.
        O[2] = prefixLen + O[2];
        // Rendered literal length for the closer: whatever of the
        // inner leftover survived, plus the outer leftover. The
        // outer leftover is retried as an opener only when nothing
        // of the inner leftover survives (a single part cannot
        // carry two runs).
        const innerRem = C[2];
        // The inner leftover belongs to this pair's inner text, so
        // it renders before the pair's close tag (marked's raw span
        // includes the whole closer run and its inner text is the
        // span minus the tag delimiters). The outer leftover renders
        // after the close tag.
        C[6] = innerRem;
        C[2] = innerRem + outerLen;
        li = list.indexOf(found, li);
        if (outerLen > 0 && innerRem === 0 && C[3]) {
          C[2] = outerLen;
          li--;
        }
        paired = true;
      }
    }
  };
  processRange(delims);
  return { opensAt, closesAt };
}

function renderParts(parts, opensAt, closesAt, plain, from, to) {
  let out = '';
  for (let i = from; i < to; i++) {
    const idx = i;
    const p = parts[idx];
    // A delimiter part may carry literal characters that belong to
    // the inner text of a pair it closes (p[6]); those render before
    // the close tags, the rest after. Plain mode renders all of them.
    const innerLit = !plain && p[0] === 1 && p[6] ? p[6] : 0;
    if (!plain) {
      if (innerLit > 0) out += p[1].repeat(innerLit);
      const closes = closesAt.get(idx);
      if (closes) for (let k = 0; k < closes.length; k++) out += '</' + closes[k] + '>';
    }
    switch (p[0]) {
      case 0:
        out += escNoEncode(p[1]);
        break;
      case 1:
        if (p[2] - innerLit > 0) out += p[1].repeat(p[2] - innerLit);
        break;
      case 2:
        if (plain) {
          out += renderParts(parts, opensAt, closesAt, true, idx + 1, p[4]);
          i = p[4];
        } else if (p[3]) {
          const alt = renderParts(parts, opensAt, closesAt, true, idx + 1, p[4]);
          out += '<img src="' + escNoEncode(p[1]) + '" alt="' + alt + '"' +
            (p[2] ? ' title="' + escNoEncode(p[2]) + '"' : '') + '>';
          i = p[4];
        } else {
          out += '<a href="' + escNoEncode(p[1]) + '"' +
            (p[2] ? ' title="' + escNoEncode(p[2]) + '"' : '') + '>';
        }
        break;
      case 3:
        if (!plain) out += '</a>';
        break;
      case 4:
        out += '[';
        break;
      case 5:
        out += '!';
        break;
      case 6:
        out += plain ? escNoEncode(p[1]) : '<code>' + escEncode(p[1]) + '</code>';
        break;
      case 7:
        if (!plain) out += p[1];
        break;
      case 8:
        if (!plain) out += '<br>';
        break;
    }
    if (!plain) {
      const opens = opensAt.get(idx);
      if (opens) for (let k = opens.length - 1; k >= 0; k--) out += '<' + opens[k] + '>';
    }
  }
  return out;
}

// Render one paragraph (or heading cell, link text, table cell) to HTML.
// defs maps normalised link labels to {href, title}.
function inline(s, defs) {
  const parts = [];
  const srcs = [];
  const delims = [];
  const brackets = [];
  const linkSpans = []; // [opener part idx, closer part idx] of formed links/images
  const autoInBrackets = []; // autolink opener part indices created inside brackets
  const n = s.length;
  let start = 0;
  let i = 0;
  const flushTo = (to) => {
    if (to > start) {
      parts.push([0, s.slice(start, to)]);
      srcs.push(start);
    }
  };
  while (i < n) {
    const ch = s[i];
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flushTo(i);
        parts.push([8]);
        srcs.push(i);
        i += 2;
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
        start = i;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx.charCodeAt(0))) {
        flushTo(i);
        parts.push([0, nx]);
        srcs.push(i);
        i += 2;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '\n') {
      // A hard break: two or more spaces before the newline. The spaces
      // are dropped, a <br> is emitted, and the next line's leading
      // spaces/tabs are skipped. Otherwise the newline is a soft break
      // and stays in the text.
      let sp = 0;
      let k = i - 1;
      while (k >= start && s.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        flushTo(i - sp);
        parts.push([8]);
        srcs.push(i);
        i++;
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i;
      while (j < n && s[j] === ch) j++;
      const caps = delimCaps(ch, s, i, j);
      flushTo(i);
      parts.push([1, ch, j - i, caps[0], caps[1], j - i]);
      srcs.push(i);
      delims.push(parts.length - 1);
      i = j;
      start = j;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const runLen = j - i;
      let k = j;
      let found = -1;
      while (k < n) {
        const bt = s.indexOf('`', k);
        if (bt < 0) break;
        let m = bt;
        while (m < n && s[m] === '`') m++;
        if (m - bt === runLen) { found = bt; break; }
        k = m;
      }
      if (found >= 0) {
        // A code span must not swallow the closing ']' of a link
        // label: marked tries the link first, so if the innermost
        // active bracket forms a link at its ']', the backticks
        // stay literal and the ']' handler forms the link.
        if (brackets.length > 0) {
          const b = brackets[brackets.length - 1];
          if (b.active) {
            const labelEnd = findLabelEnd(s, b.textStart);
            if (labelEnd > i && labelEnd < found) {
              const linkText = s.slice(b.textStart, labelEnd);
              let res = null;
              // The label must itself be valid (balanced backticks);
              // otherwise marked does not form the link and the code
              // span is free to swallow the ']'.
              if (!linkText.includes('`') || labelBackticksOk(linkText)) {
                if (s[labelEnd + 1] === '(') res = tryInlineLink(s, labelEnd + 1);
                if (!res) res = tryRefLink(s, labelEnd + 1, linkText, defs);
              }
              if (res) { i = j; continue; }
            }
          }
        }
        let content = s.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ') {
          let allSpaces = true;
          for (let q = 0; q < content.length; q++) {
            if (content[q] !== ' ') { allSpaces = false; break; }
          }
          if (!allSpaces) content = content.slice(1, -1);
        }
        flushTo(i);
        parts.push([6, content]);
        srcs.push(i);
        i = found + runLen;
        start = i;
        continue;
      }
      i = j;
      continue;
    }
    if (ch === '[') {
      flushTo(i);
      parts.push([4, false, -1]);
      srcs.push(i);
      brackets.push({ idx: parts.length - 1, image: false, bangIdx: -1, textStart: i + 1, active: true });
      i++;
      start = i;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      flushTo(i);
      parts.push([5]);
      srcs.push(i);
      const bangIdx = parts.length - 1;
      parts.push([4, true, bangIdx]);
      srcs.push(i + 1);
      brackets.push({ idx: parts.length - 1, image: true, bangIdx, textStart: i + 2, active: true });
      i += 2;
      start = i;
      continue;
    }
    if (ch === ']') {
      if (brackets.length === 0) { i++; continue; }
      const b = brackets[brackets.length - 1];
      // A deactivated bracket cannot form a link: the ']' is literal
      // and the bracket is dropped (an earlier bracket may match a
      // later ']').
      if (!b.active) { brackets.pop(); i++; continue; }
      const linkText = s.slice(b.textStart, i);
      // A label with an unbalanced backtick cannot form a link
      // (marked's label pattern has no lone-backtick alternative).
      if (linkText.includes('`') && !labelBackticksOk(linkText)) {
        brackets.pop();
        i++;
        continue;
      }
      let res = null;
      if (s[i + 1] === '(') res = tryInlineLink(s, i + 1);
      if (!res) res = tryRefLink(s, i + 1, linkText, defs);
      if (res) {
        brackets.pop();
        // A link deactivates every earlier plain bracket (a link's text
        // cannot contain another link); image brackets survive. The
        // deactivated brackets stay on the stack so a later ']' sees
        // them first and stays literal.
        if (!b.image) for (let k = brackets.length - 1; k >= 0; k--) if (!brackets[k].image) brackets[k].active = false;
        flushTo(i);
        const closeIdx = parts.length;
        parts.push([3]);
        srcs.push(i);
        parts[b.idx] = [2, res.href, res.title, b.image, closeIdx];
        linkSpans.push([b.idx, closeIdx]);
        if (b.image) parts[b.bangIdx] = [0, ''];
        start = res.end;
        i = res.end;
        continue;
      }
      brackets.pop();
      i++;
      continue;
    }
    if (ch === '<') {
      const al = tryAngleAutolink(s, i);
      if (al) {
        flushTo(i);
        const linkIdx = parts.length;
        parts.push([2, al.href, null, false, 0]);
        srcs.push(i);
        parts.push([0, escEncode(al.text)]);
        srcs.push(i);
        parts[linkIdx][4] = parts.length;
        parts.push([3]);
        srcs.push(al.end - 1);
        start = al.end;
        i = al.end;
        continue;
      }
      const tagEnd = parseInlineTag(s, i);
      if (tagEnd > 0) {
        const tagText = s.slice(i, tagEnd);
        // A start `<a ...>` tag sets the document inLink state and a
        // `</a>` tag clears it (marked's startATag is /^<a /i — a
        // bare `<a>` does not count — and endATag is /^<\/a>/i).
        if (/^<a /i.test(tagText)) docInLink = true;
        else if (/^<\/a>/i.test(tagText)) docInLink = false;
        flushTo(i);
        parts.push([7, tagText]);
        srcs.push(i);
        i = tagEnd;
        start = tagEnd;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '&') {
      const num = numericEntity(s, i);
      if (num) {
        flushTo(i);
        parts.push([0, num[0]]);
        srcs.push(i);
        i = num[1];
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '@') {
      // Bare-email autolinks are suppressed while inside an <a> tag
      // (the document-level inLink state).
      const em = docInLink ? null : tryGfmEmail(s, i, parts, srcs, delims, start);
      if (em) {
        flushTo(em.linkStart);
        const linkIdx = parts.length;
        parts.push([2, em.href, null, false, 0]);
        srcs.push(em.linkStart);
        parts.push([0, escEncode(em.text)]);
        srcs.push(em.linkStart);
        parts[linkIdx][4] = parts.length;
        parts.push([3]);
        srcs.push(em.end - 1);
        if (brackets.length > 0) autoInBrackets.push(linkIdx);
        start = em.end;
        i = em.end;
        continue;
      }
      i++;
      continue;
    }
    if (ch === 'w' && s[i + 1] === 'w' && s[i + 2] === 'w' && s[i + 3] === '.' &&
        gfmBoundary(s, i) && !docInLink) {
      const end = scanGfmUrl(s, i, brackets.length > 0 && brackets[brackets.length - 1].active, defs);
      const fc = s.charCodeAt(i + 4);
      if (end > i + 4 && (isAlnum(fc) || fc === 45)) {
        const href = cleanUrl('http://' + s.slice(i, end));
        if (href !== null) {
          flushTo(i);
          const linkIdx = parts.length;
          parts.push([2, href, null, false, 0]);
          srcs.push(i);
          parts.push([0, escEncode(s.slice(i, end))]);
          srcs.push(i);
          parts[linkIdx][4] = parts.length;
          parts.push([3]);
          srcs.push(end - 1);
          if (brackets.length > 0) autoInBrackets.push(linkIdx);
          start = end;
          i = end;
          continue;
        }
      }
      i++;
      continue;
    }
    if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
      const c1 = s[i + 1];
      if (c1 === 't' || c1 === 'T') {
        const rest = s.slice(i, i + 8).toLowerCase();
        let schemeLen = 0;
        if (rest.startsWith('http://')) schemeLen = 7;
        else if (rest.startsWith('https://')) schemeLen = 8;
        else if (rest.startsWith('ftp://')) schemeLen = 6;
        if (schemeLen > 0 && !docInLink) {
          // A scheme URL has no boundary check: it links even mid-word
          // (unlike www., which needs a word boundary).
          const end = scanGfmUrl(s, i, brackets.length > 0 && brackets[brackets.length - 1].active, defs);
          const fc = s.charCodeAt(i + schemeLen);
          if (end > i + schemeLen && (isAlnum(fc) || fc === 45)) {
            const href = cleanUrl(s.slice(i, end));
            if (href !== null) {
              flushTo(i);
              const linkIdx = parts.length;
              parts.push([2, href, null, false, 0]);
              srcs.push(i);
              parts.push([0, escEncode(s.slice(i, end))]);
              srcs.push(i);
              parts[linkIdx][4] = parts.length;
              parts.push([3]);
              srcs.push(end - 1);
              if (brackets.length > 0) autoInBrackets.push(linkIdx);
              start = end;
              i = end;
              continue;
            }
          }
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flushTo(n);
  // Autolinks (email, www, scheme) created inside brackets are plain
  // text when they ended up inside a formed link's text: marked lexes
  // a link's text with inLink set, which suppresses the url tokenizer
  // (but not the <...> autolink tokenizer, which is why angle
  // autolinks are not recorded here). The middle text part already
  // holds the escaped text; the opener/closer become empty text.
  for (let k = 0; k < autoInBrackets.length; k++) {
    const li = autoInBrackets[k];
    for (let m = 0; m < linkSpans.length; m++) {
      const sp = linkSpans[m];
      if (li > sp[0] && li < sp[1]) {
        const closeIdx = parts[li][4];
        parts[li] = [0, ''];
        parts[closeIdx] = [0, ''];
        break;
      }
    }
  }
  const { opensAt, closesAt } = processEmphasis(parts, delims, linkSpans, s, srcs);
  return renderParts(parts, opensAt, closesAt, false, 0, parts.length);
}
// ---------- block-level helpers ----------

function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Leading whitespace of a line: {cols, idx} where cols counts columns
// (a tab advances to the next multiple of 4) and idx is the character
// index just past the whitespace.
function indentInfo(line) {
  let col = 0;
  let idx = 0;
  const len = line.length;
  while (idx < len) {
    const c = line.charCodeAt(idx);
    if (c === 32) { col++; idx++; }
    else if (c === 9) { col = (Math.floor(col / 4) + 1) * 4; idx++; }
    else break;
  }
  return { cols: col, idx };
}

// Remove n columns from the start of a line, expanding tabs to spaces
// using ABSOLUTE columns. `base` is the absolute column of line[0];
// the tab stop is computed from the absolute column, so nested list
// stripping expands tabs the same way a single strip would. The
// leading whitespace of the remainder is fully expanded to spaces, so
// a tab that survives the strip still expands from its true column
// (a later indented-code parse then dedents it correctly).
function stripColsTab(line, n, base) {
  base = base || 0;
  let col = 0;
  let idx = 0;
  const len = line.length;
  while (n > 0 && idx < len) {
    const c = line.charCodeAt(idx);
    if (c === 9) {
      const stop = (Math.floor((base + col) / 4) + 1) * 4 - base;
      if (stop - col <= n) { n -= stop - col; col = stop; idx++; }
      else return expandLeadingTabs(' '.repeat(stop - col - n) + line.slice(idx + 1), base + col + n);
    } else { idx++; col++; n--; }
  }
  return expandLeadingTabs(line.slice(idx), base + col);
}

// Expand the leading tabs of s to spaces; s starts at absolute column
// startCol. Stops at the first non-whitespace character.
function expandLeadingTabs(s, startCol) {
  let col = startCol;
  let out = '';
  let k = 0;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) {
      const stop = (Math.floor(col / 4) + 1) * 4;
      out += ' '.repeat(stop - col);
      col = stop;
      k++;
    } else break;
  }
  return out + s.slice(k);
}

// Remove n columns from the start of a line. A tab that straddles the
// boundary leaves behind spaces for the part that remains. Any
// character counts as one column (a list marker is stripped this way).
// A tab that starts exactly at the boundary is kept literally.
function stripCols(line, n) {
  let col = 0;
  let idx = 0;
  const len = line.length;
  while (n > 0 && idx < len) {
    const c = line.charCodeAt(idx);
    if (c === 9) {
      const stop = (Math.floor(col / 4) + 1) * 4;
      if (stop - col <= n) { n -= stop - col; col = stop; idx++; }
      else return ' '.repeat(stop - col - n) + line.slice(idx + 1);
    } else { idx++; col++; n--; }
  }
  return line.slice(idx);
}

// Strip a blockquote marker '>' at index gtIdx. The tabs in the leading
// whitespace after '>' expand to spaces (column-aware), then one space
// is removed.
function stripBq(line, gtIdx) {
  const rest = line.slice(gtIdx + 1);
  let col = gtIdx + 1;
  let out = '';
  let k = 0;
  while (k < rest.length) {
    const c = rest.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) {
      const stop = (Math.floor(col / 4) + 1) * 4;
      out += ' '.repeat(stop - col);
      col = stop;
      k++;
    } else break;
  }
  out += rest.slice(k);
  if (out.charCodeAt(0) === 32) out = out.slice(1);
  return out;
}

function skipSpacesTabs(s, p) {
  while (p < s.length && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
  return p;
}

// ATX heading: {level, text} or null. The closing hash sequence is
// removed when it is preceded by a space.
function atxInfo(content) {
  let k = 0;
  while (k < 6 && content.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  if (k < content.length) {
    const c = content.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  let p = k;
  while (p < content.length && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
  let text = content.slice(p);
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  let h = end;
  while (h > 0 && text.charCodeAt(h - 1) === 35) h--;
  if (h < end && (h === 0 || text.charCodeAt(h - 1) === 32 || text.charCodeAt(h - 1) === 9)) {
    let t = h;
    while (t > 0 && (text.charCodeAt(t - 1) === 32 || text.charCodeAt(t - 1) === 9)) t--;
    text = text.slice(0, t);
  }
  while (text.length > 0) {
    const c2 = text.charCodeAt(text.length - 1);
    if (c2 === 32 || c2 === 9) text = text.slice(0, -1);
    else break;
  }
  return { level: k, text };
}

// Fenced code opener: {ch, len, info} or null. A backtick fence's info
// string must not contain a backtick.
function fenceInfo(content) {
  const c0 = content.charCodeAt(0);
  if (c0 !== 96 && c0 !== 126) return null;
  let k = 0;
  while (k < content.length && content.charCodeAt(k) === c0) k++;
  if (k < 3) return null;
  let info = content.slice(k);
  if (c0 === 96 && info.includes('`')) return null;
  info = info.trim();
  let lang = '';
  for (let m = 0; m < info.length; m++) {
    const c = info.charCodeAt(m);
    if (c === 32 || c === 9) break;
    lang += info[m];
  }
  return { ch: content[0], len: k, info: unescapeBackslash(lang) };
}

// A closing fence line (same char, length >= fence.len, only spaces
// after), or null. `line` is a full source line.
function fenceCloseInfo(line, fence) {
  const ind = indentInfo(line);
  if (ind.cols > 3) return false;
  const content = line.slice(ind.idx);
  const c0 = content.charCodeAt(0);
  if (c0 !== fence.ch.charCodeAt(0)) return false;
  let k = 0;
  while (k < content.length && content.charCodeAt(k) === c0) k++;
  if (k < fence.len) return false;
  for (let m = k; m < content.length; m++) {
    const c = content.charCodeAt(m);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start: returns the type 1-7, or 0. `content` is the line
// after stripping at most 3 columns of indent.
function htmlBlockStart(content) {
  if (content.charCodeAt(0) !== 60) return 0; // '<'
  const m1 = content.match(/^<(script|pre|style|textarea)(?:\s|>|\/>|$)/i);
  if (m1) return 1;
  if (content.startsWith('<!--')) return 2;
  if (content.startsWith('<?')) return 3;
  if (content.startsWith('<!') && isAlpha(content.charCodeAt(2))) return 4;
  if (content.startsWith('<![CDATA[')) return 5;
  // Type 6: a block tag (open or close).
  const m6 = content.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|>|\/>|$)/);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
  // Type 7: the line is exactly one complete open or close tag.
  const end = parseInlineTag(content, 0);
  if (end > 0) {
    let k = end;
    while (k < content.length && (content.charCodeAt(k) === 32 || content.charCodeAt(k) === 9)) k++;
    if (k === content.length) return 7;
  }
  return 0;
}

function isHr(content) {
  if (content.length === 0) return false;
  const c0 = content.charCodeAt(0);
  if (c0 !== 42 && c0 !== 45 && c0 !== 95) return false;
  let count = 0;
  for (let k = 0; k < content.length; k++) {
    const c = content.charCodeAt(k);
    if (c === c0) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// Setext underline: 1 for '=', 2 for '-', 0 otherwise. A run of one
// character, then only whitespace.
function setextInfo(content) {
  if (content.length === 0) return 0;
  const c0 = content.charCodeAt(0);
  if (c0 !== 61 && c0 !== 45) return 0;
  let k = 0;
  while (k < content.length && content.charCodeAt(k) === c0) k++;
  while (k < content.length) {
    const c = content.charCodeAt(k);
    if (c !== 32 && c !== 9) return 0;
    k++;
  }
  return c0 === 61 ? 1 : 2;
}

// List marker info, or null. `content` is the line after stripping at
// most 3 columns of indent; indentCols is the column the marker sits at.
function listMarkerInfo(content, indentCols) {
  const c0 = content.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    const c1 = content.charCodeAt(1);
    if (content.length === 1 || c1 === 32 || c1 === 9) {
      return markerInfo(content, 'bullet', indentCols, 1, null, content[0]);
    }
    return null;
  }
  if (isDigit(c0)) {
    let k = 0;
    while (k < 9 && isDigit(content.charCodeAt(k))) k++;
    if (k === 0 || k > 9) return null;
    const d = content.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    if (k + 1 < content.length) {
      const c1 = content.charCodeAt(k + 1);
      if (c1 !== 32 && c1 !== 9) return null;
    }
    const start = parseInt(content.slice(0, k), 10);
    return markerInfo(content, 'ordered', indentCols, k + 1, start, d === 46 ? '.' : ')');
  }
  return null;
}

function markerInfo(content, type, indentCols, markerLen, start, delim) {
  let p = markerLen;
  let col = indentCols + markerLen;
  let wsCols = 0;
  while (p < content.length) {
    const ch = content.charCodeAt(p);
    if (ch === 32) { p++; col++; wsCols++; }
    else if (ch === 9) {
      const stop = (Math.floor(col / 4) + 1) * 4;
      wsCols += stop - col;
      col = stop;
      p++;
    } else break;
  }
  const nonEmpty = p < content.length;
  let contentIndent;
  if (!nonEmpty) contentIndent = indentCols + markerLen + 1;
  else if (wsCols >= 1 && wsCols <= 4) contentIndent = indentCols + markerLen + wsCols;
  else contentIndent = indentCols + markerLen + 1;
  return { type, markerLen, start, delim, contentIndent, nonEmpty, contentStart: p };
}

// A list item interrupts a paragraph when it is non-empty and (for an
// ordered list) starts at 1.
function listInterrupts(marker) {
  return marker.nonEmpty && (marker.type === 'bullet' || marker.start === 1);
}

// Split a table row line into cells (trimmed). Returns null when the line
// has no '|'. A leading/trailing '|' is optional; '\|' is a literal pipe.
function splitTableRow(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  let s = line.slice(a, b);
  if (!s.includes('|')) return null;
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// A table delimiter row: returns its cells (each matching :?-+:?) or null.
function isTableDelim(content) {
  const cells = splitTableRow(content);
  if (!cells) return null;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
  }
  return cells;
}

// Parse a link reference definition starting at text[pos] === '['.
// Returns {label, href, title, end} or null. `end` is just past the
// destination or title; the definition's line ends after that.
function parseDef(text, pos) {
  const close = findLabelEnd(text, pos + 1);
  if (close < 0) return null;
  const labelRaw = text.slice(pos + 1, close);
  if (labelRaw.length === 0 || labelRaw.length > 999) return null;
  const label = normalizeLabel(labelRaw);
  if (label.length === 0) return null; // a label that folds to empty
  if (text.charCodeAt(close + 1) !== 58) return null; // ':'
  let p = skipSpacesTabs(text, close + 2);
  if (text.charCodeAt(p) === 10) {
    p++;
    p = skipSpacesTabs(text, p);
  }
  let destRes = null;
  if (text.charCodeAt(p) === 60) {
    destRes = parseAngleDest(text, p);
    if (!destRes) return null;
  } else {
    destRes = parseBareDest(text, p);
    if (!destRes) return null;
  }
  const href = cleanUrl(unescapeBackslash(destRes.dest));
  if (href === null) return null;
  let title = null;
  let end = destRes.end;
  const q = skipSpacesTabs(text, end);
  if (q < text.length && text.charCodeAt(q) === 10) {
    // A title on the next line is optional: if it fails to parse, or
    // junk follows it on its line, the definition still stands
    // without a title.
    const r = skipSpacesTabs(text, q + 1);
    const qc = text.charCodeAt(r);
    if (qc === 34 || qc === 39 || qc === 40) {
      const t = parseTitle(text, r);
      if (t) {
        const s2 = skipSpacesTabs(text, t.end);
        if (s2 >= text.length || text.charCodeAt(s2) === 10) {
          title = t.title;
          end = t.end;
        }
      }
    }
  } else {
    const qc = text.charCodeAt(q);
    if (qc === 34 || qc === 39 || qc === 40) {
      // A same-line title needs whitespace between it and the dest.
      if (q === end) return null;
      const t = parseTitle(text, q);
      if (!t) return null;
      title = t.title;
      const s2 = skipSpacesTabs(text, t.end);
      if (s2 < text.length && text.charCodeAt(s2) !== 10) return null;
      end = t.end;
    } else if (q < text.length) {
      return null; // junk after the destination on the same line
    }
  }
  return { label, href, title, end };
}

// Extract the leading link reference definitions from a paragraph's
// text, registering them in defs. Returns the remaining text.
function extractDefs(text, defs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let col = 0;
    let p = pos;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 32) { col++; p++; }
      else if (c === 9) { col = (Math.floor(col / 4) + 1) * 4; p++; }
      else break;
    }
    if (col > 3 || text.charCodeAt(p) !== 91) break; // not '['
    const def = parseDef(text, p);
    if (!def) break;
    if (!defs.has(def.label)) defs.set(def.label, { href: def.href, title: def.title });
    const nl = text.indexOf('\n', def.end);
    if (nl < 0) { pos = n; break; }
    pos = nl + 1;
  }
  let rest = text.slice(pos);
  if (rest.charCodeAt(0) === 10) rest = rest.slice(1);
  return rest;
}

// Does a line (after stripping at most 3 columns of indent) start a
// block? Used to decide whether a lazy continuation line may continue a
// paragraph, and to track the open block inside a container.
function blockStartContent(content, indentCols) {
  if (atxInfo(content) || fenceInfo(content) || htmlBlockStart(content) ||
      isHr(content) || content[0] === '>') return true;
  return listMarkerInfo(content, indentCols) !== null;
}

// State of the open block while collecting a container's lines.
function createBlockState() {
  return { inFence: null, lastIsPara: false, inTable: false, lastLine: null };
}

// Strip nested blockquote markers and list markers to find the
// innermost content of a line (the container markup a fence or a
// lazy line sits behind). Used both when a fence opens and when one
// closes: a closing fence inside a blockquote is written `> ````,
// and checking the raw line would never match it, leaving inFence
// stuck so the enclosing list item swallows every following block.
function stripContainers(line) {
  let inner = line;
  while (true) {
    const ind2 = indentInfo(inner);
    if (ind2.cols > 3) break;
    const c2 = inner.slice(ind2.idx);
    if (c2.charCodeAt(0) === 62) { // '>'
      inner = stripBq(inner, inner.indexOf('>', ind2.idx));
      continue;
    }
    const m2 = listMarkerInfo(c2, ind2.cols);
    if (m2 && m2.nonEmpty) {
      inner = c2.slice(m2.contentStart);
      continue;
    }
    break;
  }
  return inner;
}

function updateBlockState(st, line) {
  if (isBlank(line)) {
    st.lastIsPara = false;
    st.inTable = false;
    return;
  }
  if (st.inFence) {
    if (fenceCloseInfo(stripContainers(line), st.inFence)) st.inFence = null;
    st.lastIsPara = false;
    st.inTable = false;
    return;
  }
  // Strip nested blockquote markers and list markers to find the
  // innermost content; the open block a lazy line could continue is
  // the innermost one.
  line = stripContainers(line);
  const ind = indentInfo(line);
  if (ind.cols >= 4) return; // paragraph continuation, or indented code
  const content = line.slice(ind.idx);
  const f = fenceInfo(content);
  if (f) {
    st.inFence = f;
    st.lastIsPara = false;
    st.inTable = false;
    st.lastLine = line;
    return;
  }
  if (st.lastIsPara && st.lastLine !== null && st.lastLine.includes('|')) {
    const dc = isTableDelim(content);
    const hc = splitTableRow(st.lastLine);
    if (dc && hc && dc.length === hc.length) {
      st.inTable = true;
      st.lastIsPara = false;
      st.lastLine = line;
      return;
    }
  }
  if (st.inTable) {
    // A table body row keeps the table open; anything else ends it.
    if (!blockStartContent(content, ind.cols)) {
      st.lastIsPara = false;
      st.lastLine = line;
      return;
    }
    st.inTable = false;
  }
  if (st.lastIsPara && setextInfo(content)) {
    // A setext underline closes the paragraph into a heading.
    st.lastIsPara = false;
    st.lastLine = line;
    return;
  }
  if (blockStartContent(content, ind.cols)) {
    st.lastIsPara = false;
  } else {
    st.lastIsPara = true;
  }
  st.lastLine = line;
}

// Can `line` continue a paragraph lazily (inside a blockquote or list
// item)? It must not start a block of its own. A '===' line may continue
// a paragraph (it is only a setext underline inside the container);
// '---' may not, because it is a thematic break.
function isLazyLine(line) {
  if (isBlank(line)) return false;
  const ind = indentInfo(line);
  if (ind.cols >= 4) return true;
  const content = line.slice(ind.idx);
  if (fenceInfo(content) || atxInfo(content) || htmlBlockStart(content) ||
      isHr(content) || content[0] === '>') return false;
  return listMarkerInfo(content, ind.cols) === null;
}
// ---------- block parsers ----------

// Indented code: lines with indent >= 4. Blank lines are kept only when
// more code follows. Returns {text, next} where text is the code content
// (each line minus 4 columns, plus a trailing newline).
function parseIndentedCode(lines, i) {
  let text = '';
  let j = i;
  let pend = []; // extra spaces of pending blank lines (cols beyond 4)
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      const ind = indentInfo(line);
      pend.push(ind.cols > 4 ? ' '.repeat(ind.cols - 4) : '');
      j++;
      continue;
    }
    const ind = indentInfo(line);
    if (ind.cols < 4) break;
    for (let p = 0; p < pend.length; p++) text += pend[p] + '\n';
    pend = [];
    text += stripCols(line, 4) + '\n';
    j++;
  }
  return { text, next: j };
}

// Fenced code: lines[i] is the opening fence (info already parsed).
// Returns {text, next}.
// Remove up to n columns of LEADING WHITESPACE only (for fenced-code
// dedent). A line with less indent than n loses only its whitespace;
// content characters are never removed.
function stripIndent(line, n) {
  let col = 0;
  let idx = 0;
  const len = line.length;
  while (n > 0 && idx < len) {
    const c = line.charCodeAt(idx);
    if (c === 32) { idx++; col++; n--; }
    else if (c === 9) {
      const stop = (Math.floor(col / 4) + 1) * 4;
      if (stop - col <= n) { n -= stop - col; col = stop; idx++; }
      else return ' '.repeat(stop - col - n) + line.slice(idx + 1);
    } else break;
  }
  return line.slice(idx);
}

function parseFencedCode(lines, i, fence, fenceIndentStr) {
  let text = '';
  let j = i + 1;
  let closed = false;
  // Marked dedents a fenced block's content by the opening fence's
  // indent only for backtick fences (its indentCodeCompensation
  // matches ```, never ~~~): a tilde fence keeps its content's
  // indent exactly. The dedent is by CHARACTER count (marked's
  // Dt slices min(leadingWhitespace.length, indent.length) chars
  // off each content line), not by columns, so a tab counts as one.
  const strip = fence.ch === '`' ? fenceIndentStr.length : 0;
  while (j < lines.length) {
    const line = lines[j];
    if (fenceCloseInfo(line, fence)) { closed = true; break; }
    const m = strip > 0 ? line.match(/^\s+/) : null;
    text += (m ? line.slice(Math.min(m[0].length, strip)) : line) + '\n';
    j++;
  }
  // Marked's fences regex captures the content minus the final
  // newline before the closing fence, and its renderer outputs that
  // text with a single trailing newline (stripping one and adding
  // one back), or nothing when it is empty. So one blank line
  // renders empty, two blank lines render one "\n", three render
  // two, and so on.
  if (closed) {
    let e = text.endsWith('\n') ? text.slice(0, -1) : text;
    text = e === '' ? '' : (e.endsWith('\n') ? e : e + '\n');
  }
  return { text, next: closed ? j + 1 : j };
}

// HTML block: lines[i] starts one of type 1-7. Returns {text, next}.
function parseHtmlBlock(lines, i, type, endsWithNL) {
  let j = i;
  if (type >= 1 && type <= 5) {
    while (j < lines.length) {
      const line = lines[j];
      if (type === 1) {
        if (/<\/(script|pre|style|textarea)(?:\s|>|$)/i.test(line)) { j++; break; }
      } else if (type === 2) {
        if (line.includes('-->')) { j++; break; }
      } else if (type === 3) {
        if (line.includes('?>')) { j++; break; }
      } else if (type === 4) {
        if (line.includes('>')) { j++; break; }
      } else if (type === 5) {
        if (line.includes(']]>')) { j++; break; }
      }
      j++;
    }
  } else {
    // Types 6 and 7 end at the first blank line.
    j++;
    while (j < lines.length && !isBlank(lines[j])) j++;
  }
  let text = lines.slice(i, j).join('\n');
  // Whether the block's trailing newline survives depends on the
  // next line and the type: marked's types 1-5 end their raw text
  // at the closing line's newline, which a following whitespace-only
  // line does not swallow (only a truly empty line does); types 6-7
  // swallow any blank line after them.
  const afterBlank = j < lines.length
    ? (type >= 6 ? isBlank(lines[j]) : lines[j] === '')
    : !endsWithNL;
  if (!afterBlank || (j >= lines.length && endsWithNL)) text += '\n';
  return { text, next: j };
}

// A paragraph (and possibly a table or setext heading) starting at i.
// `defs` is the shared link-definition map. Returns {nodes, next}.
function parseParagraph(lines, i, defs, endsWithNL, lazyFlags, inItem) {
  const collected = [i];
  let j = i + 1;
  let tableAt = -1;
  let tableDelimAt = -1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      // A lazy line that is whitespace-only but non-empty (it came
      // from a `>` line with trailing spaces) is a paragraph line,
      // not a blank separator.
      if (lazyFlags && lazyFlags[j] && line.length > 0) { collected.push(j); j++; continue; }
      break;
    }
    const ind = indentInfo(line);
    const content = line.slice(ind.idx);
    if (ind.cols <= 3) {
      const sx = setextInfo(content);
      if (sx && !(lazyFlags && lazyFlags[j])) {
        // A setext underline only makes a heading if the paragraph
        // text (after link definitions are taken out) is non-empty.
        // Otherwise the line is an ordinary paragraph line.
        const paraText = collected.map(x => lines[x]).join('\n');
        const rest = extractDefs(paraText, defs);
        const htext = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        if (htext !== '') return { nodes: [{ type: 'heading', level: sx, text: htext }], next: j + 1 };
        collected.push(j);
        j++;
        continue;
      }
      const prev = lines[j - 1];
      const dc = prev.includes('|') ? isTableDelim(content) : null;
      const hc = dc ? splitTableRow(prev) : null;
      if (dc && hc && dc.length === hc.length) {
        if (lazyFlags && lazyFlags[j] && collected.length === 1) {
          // In a blockquote, a table whose header is the paragraph's
          // first line does not form when the delimiter is a lazy line.
          collected.push(j);
          j++;
          continue;
        }
        tableAt = j - 1;
        tableDelimAt = j;
        break;
      }
      // A lazy continuation line is part of this paragraph; it never
      // starts a new block (heading, fence, list, or hr).
      if (lazyFlags && lazyFlags[j]) { collected.push(j); j++; continue; }
      if (atxInfo(content) || fenceInfo(content) || isHr(content) || content[0] === '>') break;
      // An HTML block interrupts a paragraph, except type 7 (a line
      // that is exactly one complete tag).
      const hb = htmlBlockStart(content);
      if (hb && hb !== 7) break;
      const lm = listMarkerInfo(content, ind.cols);
      // Inside a list item, any non-empty list marker interrupts a
      // paragraph, whatever its start number; elsewhere an ordered
      // list interrupts only when it starts at 1.
      if (lm && (inItem ? lm.nonEmpty : listInterrupts(lm))) break;
    }
    collected.push(j);
    j++;
  }
  const paraText = collected.map(x => lines[x]).join('\n');
  if (tableAt >= 0) {
    const pStart = collected[0];
    const tbl = buildTable(lines, pStart, tableAt, tableDelimAt, defs);
    return { nodes: tbl.nodes, next: tbl.next };
  }
  const rest = extractDefs(paraText, defs);
  if (rest.trim() === '') return { nodes: [{ type: 'def' }], next: j };
  return { nodes: [{ type: 'paragraph', text: rest }], next: j };
}

// Parse a table whose header is line `h` and delimiter is line `d`.
// `paraStart` is the first line of the paragraph that precedes the
// table. Returns {nodes, next}.
function buildTable(lines, paraStart, h, d, defs) {
  const nodes = [];
  const header = splitTableRow(lines[h]);
  const delimCells = isTableDelim(lines[d]);
  const aligns = delimCells.map(c => (c.startsWith(':') && c.endsWith(':')) ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null);
  const rows = [];
  let k = d + 1;
  while (k < lines.length) {
    const line = lines[k];
    if (isBlank(line)) {
      // A whitespace-only line that contains a tab is a table row
      // of empty cells in marked (its row pattern only excludes a
      // spaces-only line, and a lone tab is not indented code);
      // a spaces-only line ends the table.
      if (line.includes('\t')) {
        const row = [];
        for (let m = 0; m < header.length; m++) row.push('');
        rows.push(row);
        k++;
        continue;
      }
      break;
    }
    const ind = indentInfo(line);
    if (ind.cols <= 3) {
      const content = line.slice(ind.idx);
      if (atxInfo(content) || fenceInfo(content) || htmlBlockStart(content) ||
          isHr(content) || content[0] === '>' || listMarkerInfo(content, ind.cols)) break;
    }
    const cells = splitTableRow(line) || [line.trim()];
    const row = [];
    for (let m = 0; m < header.length; m++) row.push(cells[m] !== undefined ? cells[m] : '');
    rows.push(row);
    k++;
  }
  const text = lines.slice(paraStart, h).join('\n');
  const rest = extractDefs(text, defs);
  if (rest.trim() !== '') nodes.push({ type: 'paragraph', text: rest });
  nodes.push({ type: 'table', header, aligns, rows });
  return { nodes, next: k };
}

// A blockquote starting at line i. Returns {node, next}.
function parseBlockquote(lines, i, defs, endsWithNL) {
  const sub = [];
  const st = createBlockState();
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const ind = indentInfo(line);
    if (ind.cols <= 3) {
      const gt = line.indexOf('>', ind.idx);
      if (gt >= 0 && line.slice(ind.idx, gt).trim() === '') {
        const subLine = stripBq(line, gt);
        // A `>` line that strips to whitespace only (but not empty)
        // is a paragraph line carrying those spaces, not a blank.
        sub.push({ line: subLine, lazy: subLine.length > 0 && subLine.trim() === '' });
        updateBlockState(st, subLine);
        j++;
        continue;
      }
    }
    if (isBlank(line)) break;
    if (st.lastIsPara && isLazyLine(line)) {
      // A lazy line's leading whitespace is stripped by four columns
      // when it would otherwise be indented code; a smaller indent
      // is kept as-is.
      let lazyLine = indentInfo(line).cols >= 4 ? stripIndent(line, 4) : line;
      // A lazy setext `=` underline that follows another lazy line
      // is kept literal by indenting it four columns, so it is not
      // re-read as a heading underline.
      const prevLazy = sub.length > 0 && sub[sub.length - 1].lazy;
      if (prevLazy && setextInfo(lazyLine.trimStart()) === 1) {
        lazyLine = '    ' + lazyLine.trimStart();
      }
      sub.push({ line: lazyLine, lazy: true });
      updateBlockState(st, lazyLine);
      j++;
      continue;
    }
    break;
  }
  const subLines = sub.map(x => x.line);
  const subLazy = sub.map(x => x.lazy);
  const children = parseBlocks(subLines, defs, endsWithNL && j >= lines.length, subLazy);
  return { node: { type: 'blockquote', children }, next: j };
}

// A list starting at line i. Returns {node, next}.
function parseList(lines, i, defs, endsWithNL, colBase) {
  const firstInd = indentInfo(lines[i]);
  const first = listMarkerInfo(lines[i].slice(firstInd.idx), firstInd.cols);
  const type = first.type;
  const items = [];
  let loose = false;
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k < lines.length) {
        const ind2 = indentInfo(lines[k]);
        const m2 = ind2.cols <= 3 ? listMarkerInfo(lines[k].slice(ind2.idx), ind2.cols) : null;
        if (m2 && m2.type === type && m2.delim === first.delim && ind2.cols <= 3) {
          loose = true;
          j = k;
          continue;
        }
      }
      break;
    }
    const ind = indentInfo(line);
    if (ind.cols > 3) break;
    // A thematic break ends the list; it is not a new item.
    if (isHr(line.slice(ind.idx))) break;
    const m = listMarkerInfo(line.slice(ind.idx), ind.cols);
    if (!m || m.type !== type || m.delim !== first.delim) break;
    const res = collectItem(lines, j, m, defs, endsWithNL, colBase);
    // An item is loose when a blank line separates two of its direct
    // child blocks. Blank lines nested deeper (inside a child list or
    // blockquote) do not loosen this list.
    for (let ci = 1; ci < res.item.children.length; ci++) {
      if (res.item.children[ci].blankBefore) { loose = true; break; }
    }
    items.push(res.item);
    j = res.next;
  }
  return { node: { type: 'list', listType: type, start: type === 'ordered' ? first.start : 1, items, loose }, next: j };
}

// Collect one list item starting at line i. Returns {item, next, itemLoose}.
function collectItem(lines, i, marker, defs, endsWithNL, colBase) {
  const sub = [];
  const st = createBlockState();
  let itemLoose = false;
  let j = i;
  const firstLine = stripColsTab(lines[i], marker.contentIndent, colBase || 0);
  sub.push({ line: firstLine, lazy: false });
  updateBlockState(st, firstLine);
  j++;
  let blankCount = 0;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      // A blank line inside a fenced code block is fence content:
      // it neither ends the item nor counts toward the blank limit.
      if (st.inFence) {
        sub.push({ line: '', lazy: false });
        blankCount = 0;
        j++;
        continue;
      }
      blankCount++;
      if (blankCount > 1) break;
      // An item that has no content yet ends at a blank line: it can
      // begin with at most one blank line, and only when content
      // follows on the next line without a blank in between.
      if (sub.every(s => s.line.trim() === '')) break;
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k >= lines.length) break;
      const ind2 = indentInfo(lines[k]);
      const m2 = ind2.cols <= 3 ? listMarkerInfo(lines[k].slice(ind2.idx), ind2.cols) : null;
      if (m2 && ind2.cols < marker.contentIndent) break; // a sibling item
      if (ind2.cols >= marker.contentIndent || m2) {
        // Content after the blank belongs to this item: keep one
        // blank line per blank line skipped.
        for (let b = j; b < k; b++) sub.push({ line: '', lazy: false });
        sub.push({ line: stripColsTab(lines[k], marker.contentIndent, colBase || 0), lazy: false });
        updateBlockState(st, stripColsTab(lines[k], marker.contentIndent, colBase || 0));
        itemLoose = true;
        blankCount = 0;
        j = k + 1;
        continue;
      }
      // After a blank line, a line indented less than the content
      // indent ends the item (a lazy line cannot resume it).
      break;
    }
    const ind = indentInfo(line);
    if (ind.cols >= marker.contentIndent) {
      const subLine = stripColsTab(line, marker.contentIndent, colBase || 0);
      sub.push({ line: subLine, lazy: false });
      updateBlockState(st, subLine);
      blankCount = 0;
      j++;
      continue;
    }
    // Inside a fenced code block, a line belongs to the item no
    // matter its indent (fence content is literal). Strip only
    // leading whitespace, never content characters.
    if (st.inFence) {
      const subLine = stripIndent(line, marker.contentIndent);
      sub.push({ line: subLine, lazy: false });
      updateBlockState(st, subLine);
      blankCount = 0;
      j++;
      continue;
    }
    // A lazy continuation of an open paragraph, even one indented
    // four or more columns (indented code cannot interrupt a
    // paragraph), stays in the item. Its leading whitespace is
    // stripped by the content indent (when it reaches that far) and
    // then by four columns when it would otherwise be indented code.
    if (st.lastIsPara && isLazyLine(line)) {
      let lazyLine = line;
      let indCols = ind.cols;
      if (indCols >= marker.contentIndent) {
        lazyLine = stripIndent(lazyLine, marker.contentIndent);
        indCols -= marker.contentIndent;
      }
      if (indCols >= 4) lazyLine = stripIndent(lazyLine, 4);
      sub.push({ line: lazyLine, lazy: true });
      updateBlockState(st, lazyLine);
      blankCount = 0;
      j++;
      continue;
    }
    if (ind.cols > 3) break;
    const content = line.slice(ind.idx);
    if (listMarkerInfo(content, ind.cols)) break;
    break;
  }
  const subLines = sub.map(x => x.line);
  const subLazy = sub.map(x => x.lazy);
  const children = parseBlocks(subLines, defs, endsWithNL && j >= lines.length, subLazy, (colBase || 0) + marker.contentIndent, true);
  return { item: { children }, next: j, itemLoose };
}

// The top-level (and container) block parser. `lazyFlags` marks lines
// that were lazy continuations of a container (parallel to `lines`),
// or null at the top level. Each node gets a `blankBefore` flag that is
// true when blank lines separated it from the previous block in this
// sequence (used to decide whether a list is loose).
function parseBlocks(lines, defs, endsWithNL, lazyFlags, colBase, inItem) {
  const nodes = [];
  let sawBlank = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { if (nodes.length > 0) sawBlank = true; i++; continue; }
    const ind = indentInfo(line);
    const content = line.slice(ind.idx);
    let node = null;
    if (ind.cols >= 4) {
      const res = parseIndentedCode(lines, i);
      node = { type: 'code', info: '', text: res.text };
      i = res.next;
    } else {
      const f = fenceInfo(content);
      if (f) {
        const res = parseFencedCode(lines, i, f, line.slice(0, ind.idx));
        node = { type: 'code', info: f.info, text: res.text };
        i = res.next;
      } else {
        const ax = atxInfo(content);
        if (ax) {
          node = { type: 'heading', level: ax.level, text: ax.text };
          i++;
        } else {
          const ht = htmlBlockStart(content);
          if (ht) {
            const res = parseHtmlBlock(lines, i, ht, endsWithNL);
            node = { type: 'html', text: res.text };
            i = res.next;
          } else if (isHr(content)) {
            node = { type: 'hr' };
            i++;
          } else if (content[0] === '>') {
            const res = parseBlockquote(lines, i, defs, endsWithNL);
            node = res.node;
            i = res.next;
          } else {
            const lm = listMarkerInfo(content, ind.cols);
            if (lm) {
              const res = parseList(lines, i, defs, endsWithNL, colBase || 0);
              node = res.node;
              i = res.next;
            } else {
              const res = parseParagraph(lines, i, defs, endsWithNL, lazyFlags, inItem);
              for (let n2i = 0; n2i < res.nodes.length; n2i++) { res.nodes[n2i].blankBefore = n2i === 0 ? sawBlank : false; nodes.push(res.nodes[n2i]); }
              sawBlank = false;
              i = res.next;
              continue;
            }
          }
        }
      }
    }
    if (node) { node.blankBefore = sawBlank; nodes.push(node); sawBlank = false; }
  }
  return nodes;
}

// ---------- rendering ----------

function renderBlocks(nodes, defs, tight) {
  let out = '';
  for (const n of nodes) out += renderBlock(n, defs, tight);
  return out;
}

function renderBlock(n, defs, tight) {
  switch (n.type) {
    case 'def':
      return ''; // a link-reference-definition-only block renders nothing
    case 'paragraph':
      if (tight) return inline(n.text, defs);
      return '<p>' + inline(n.text, defs) + '</p>\n';
    case 'heading':
      return '<h' + n.level + '>' + inline(n.text, defs) + '</h' + n.level + '>\n';
    case 'code': {
      let tag = '<pre><code';
      if (n.info) tag += ' class="language-' + escNoEncode(n.info) + '"';
      return tag + '>' + escEncode(n.text) + '</code></pre>\n';
    }
    case 'html':
      return n.text;
    case 'hr':
      return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(n.children, defs, false) + '</blockquote>\n';
    case 'list': {
      let out = n.listType === 'ordered'
        ? (n.start !== 1 ? '<ol start="' + n.start + '">\n' : '<ol>\n')
        : '<ul>\n';
      for (const it of n.items) out += renderItem(it, n, defs);
      out += n.listType === 'ordered' ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let m = 0; m < n.header.length; m++) {
        const a = n.aligns[m];
        out += a ? '<th align="' + a + '">' + inline(n.header[m], defs) + '</th>\n' : '<th>' + inline(n.header[m], defs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (n.rows.length > 0) {
        out += '<tbody>';
        for (const row of n.rows) {
          out += '<tr>\n';
          for (let m = 0; m < row.length; m++) {
            const a = n.aligns[m];
            out += a ? '<td align="' + a + '">' + inline(row[m], defs) + '</td>\n' : '<td>' + inline(row[m], defs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
  }
  return '';
}

function renderItem(it, list, defs) {
  let out = '<li>';
  const kids = it.children;
  // A task list item: its first paragraph starts with '[ ] ', '[x] '
  // or '[X] ' (case-insensitive x). The marker becomes a checkbox.
  let task = null;
  if (kids.length > 0 && kids[0].type === 'paragraph') {
    const t = kids[0].text;
    if (t.length >= 4 && t[0] === '[' && t[2] === ']' && t[3] === ' ') {
      const c = t[1];
      if (c === ' ') task = '<input disabled="" type="checkbox">';
      else if (c === 'x' || c === 'X') task = '<input checked="" disabled="" type="checkbox">';
    }
  }
  if (list.loose) {
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k];
      if (k === 0 && task && c.type === 'paragraph') {
        out += '<p>' + task + inline(c.text.slice(3), defs) + '</p>\n';
      } else {
        out += renderBlock(c, defs, false);
      }
    }
  } else {
    // A tight item renders its first paragraph inline; later blocks
    // render normally, except a later paragraph also renders inline.
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k];
      if (c.type === 'paragraph') {
        if (k === 0 && task) out += task + inline(c.text.slice(3), defs);
        else out += inline(c.text, defs);
      } else {
        out += renderBlock(c, defs, false);
      }
    }
  }
  out += '</li>\n';
  return out;
}

// ---------- entry point ----------

// Whether the inline lexer is currently inside an <a> tag: marked
// sets this when it lexes a start `<a ...>` tag and clears it on
// `</a>`, and the state persists across paragraphs for the whole
// document, suppressing bare-URL/email autolinks (but not <...>
// autolinks). Only inline tags count — an <a> in an HTML block is
// never lexed inline, so it does not set the state. Reset per
// document in parse().
let docInLink = false;

export function parse(markdown) {
  docInLink = false;
  const src = markdown.replace(/\r\n?/g, '\n');
  const endsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNL) lines.pop();
  const defs = new Map();
  const nodes = parseBlocks(lines, defs, endsWithNL, null);
  return renderBlocks(nodes, defs, false);
}

// parse.js — a dependency-free CommonMark 0.31.2 + GFM 0.29 renderer,
// written from scratch. parse(markdown) returns exactly the HTML that
// marked 18.1.3 renders with its defaults (GFM on, breaks off, pedantic
// off, async off). No third-party code is used here.

export function parse(src) {
  htmlLinkOpen = false;
  const root = parseBlocks(src);
  const refs = root.refs;
  const out = [];
  renderBlocks(root, refs, out);
  return out.join('');
}

// Whether an unclosed inline <a> tag has been seen so far in this
// document. Marked treats an unclosed <a> as opening a link whose
// state leaks across blocks: later bare autolinks (URL, www, email,
// xmpp) are suppressed until a </a> appears. Markdown links and
// angle autolinks are not suppressed.
let htmlLinkOpen = false;

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isBlank(c) {
  return c === 32 || c === 9;
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) {
  return isAlpha(c) || isDigit(c);
}
// ASCII punctuation, per the CommonMark spec.
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode whitespace (space separators plus the ASCII controls the spec
// treats as whitespace). ASCII fast path first.
function isUnicodeSpace(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isSpace(c);
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}
const punctCache = new Map();
function isUnicodePunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  let v = punctCache.get(ch);
  if (v === undefined) {
    v = /[\p{P}\p{S}]/u.test(ch);
    punctCache.set(ch, v);
  }
  return v;
}

// ---------------------------------------------------------------------------
// HTML escaping and entities
// ---------------------------------------------------------------------------

// Escape a string for HTML text content. `&` is left alone when it starts
// a valid entity reference (&name; or a valid numeric reference); a lone
// `&` becomes &amp;. `"` and `'` are escaped as well (marked's escape()).
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!entityAhead(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape for code spans / code blocks / raw text where every `&` is
// encoded, even a valid entity reference.
function escAll(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape for attribute values (href, title, info strings): like escText.
function escAttr(s) {
  return escText(s);
}

// True when s[i] === '&' and the characters ahead form a valid entity
// reference: &name; (any word), &#123; (1-7 decimal digits) or
// &#x1a; / &#X1a; (1-6 hex digits).
function entityAhead(s, i) {
  let j = i + 1;
  if (j >= s.length) return false;
  if (s.charCodeAt(j) === 35) {
    j++;
    if (j < s.length && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const st = j;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) j++;
        else break;
      }
      return j - st >= 1 && j - st <= 6 && j < s.length && s[j] === ';';
    }
    const st = j;
    while (j < s.length && isDigit(s.charCodeAt(j))) j++;
    return j - st >= 1 && j - st <= 7 && j < s.length && s[j] === ';';
  }
  const st = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlnum(c)) j++;
    else break;
  }
  return j - st >= 1 && j < s.length && s[j] === ';';
}

// Decode a numeric character reference starting at s[i] === '&'.
// Returns [decodedString, endIndex] or null when not a valid reference.
function decodeNumericEntity(s, i) {
  let j = i + 2;
  let hex = false;
  if (j < s.length && (s[j] === 'x' || s[j] === 'X')) {
    hex = true;
    j++;
  }
  const st = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (hex ? (isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) : isDigit(c)) j++;
    else break;
  }
  const digits = j - st;
  if (digits === 0 || digits > (hex ? 6 : 7) || j >= s.length || s[j] !== ';') return null;
  const n = parseInt(s.slice(st, j), hex ? 16 : 10);
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ['\uFFFD', j + 1];
  return [String.fromCodePoint(n), j + 1];
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

// marked's cleanUrl: percent-encode the URL, keeping literal % signs.
// Returns null when the URL cannot be encoded (lone surrogates).
function cleanUrl(url) {
  let enc;
  try {
    enc = encodeURI(url).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
  return enc;
}

// Normalize a link label: collapse internal whitespace to single spaces,
// trim, and lowercase (Unicode-aware via toLowerCase).
function normalizeLabel(label) {
  // Unicode case folding: toLowerCase plus the full-case mappings
  // that lowercasing misses (sharp s and ligatures fold to letters).
  return label.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Unescape backslash escapes of ASCII punctuation in a link destination
// or title. `\<` -> `<`, `\\` -> `\`, etc.
function unescapeStr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1];
      i++;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Node shapes:
//  {t:'text', s}            raw text, escaped at render
//  {t:'raw', s}             already-escaped / verbatim output
//  {t:'code', s}            code span content
//  {t:'html', s}            raw inline HTML
//  {t:'br'}                 hard line break
//  {t:'delim', ch, n, open, close}   emphasis / strikethrough delimiter run
//  {t:'link', href, title, children, img}  link or image
//  {t:'open', img}          unmatched '[' / '![' placeholder (becomes text)

// Flanking for a delimiter run starting at str[i] with length len.
function flanking(str, i, len) {
  const before = i > 0 ? str[i - 1] : undefined;
  const after = i + len < str.length ? str[i + len] : undefined;
  // The beginning and the end of the line count as Unicode whitespace.
  const beforeSpace = before === undefined || isUnicodeSpace(before);
  const afterSpace = after === undefined || isUnicodeSpace(after);
  const beforePunct = before !== undefined && isUnicodePunct(before);
  const afterPunct = after !== undefined && isUnicodePunct(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return { left, right, before, after };
}

// Parse a link destination starting at s[i] (after optional whitespace was
// already skipped by the caller). Returns {dest, next} or null.
function parseDest(s, i) {
  if (i >= s.length) return null;
  if (s.charCodeAt(i) === 60) {
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest: s.slice(i + 1, j), next: j + 1 };
      if (c === 10 || c === 60) return null;
      if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) j += 2;
      else j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 127) break;
    if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return null;
  return { dest: s.slice(i, j), next: j };
}

// Parse a link title starting at s[i] ('"', "'" or '(').
// Returns {title, next} or null.
function parseTitle(s, i) {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
        j += 2;
        continue;
      }
      if (s[j] === q) return { title: s.slice(i + 1, j), next: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    let depth = 0;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
        j += 2;
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) return { title: s.slice(i + 1, j), next: j + 1 };
        depth--;
      }
      j++;
    }
    return null;
  }
  return null;
}

function skipInlineSpace(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Try to parse an inline link "(dest title)" starting at s[i] === '('.
// Returns {dest, title, next} or null.
function parseInlineLink(s, i) {
  let j = skipInlineSpace(s, i + 1);
  let d = parseDest(s, j);
  if (!d) {
    // An empty destination "()" is valid for an inline link
    // (but not for a link reference definition).
    if (j < s.length && s.charCodeAt(j) === 41) d = { dest: '', next: j };
    else return null;
  }
  j = skipInlineSpace(s, d.next);
  let title = null;
  if (j < s.length && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const t = parseTitle(s, j);
    if (!t) return null;
    title = t.title;
    j = skipInlineSpace(s, t.next);
  }
  if (j >= s.length || s.charCodeAt(j) !== 41) return null;
  return { dest: d.dest, title, next: j + 1 };
}

// ---------------------------------------------------------------------------
// GFM autolinks (bare www. / scheme:// / email)
// ---------------------------------------------------------------------------

function isDomainChar(c) {
  return isAlnum(c) || c === 95 || c === 45; // alnum, _, -
}

function isEmailLocalChar(c) {
  return isAlnum(c) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 43 || c === 47 || c === 61 || c === 63 ||
    c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 45;
  // NOTE: '*' (42) and '~' (126) are NOT valid local-part chars:
  // marked breaks the email at them (foo*bar@x.com links only
  // bar@x.com). '_' (95) IS valid (foo_bar@x.com links whole).
}

// The character before a bare www./scheme autolink must be the start of
// the string, whitespace, or one of ( * _ ~.
function autolinkBoundaryOk(str, i) {
  if (i === 0) return true;
  const c = str.charCodeAt(i - 1);
  // '[' is allowed: a URL right after '[' is autolinked when the
  // '[' does not form a link ('[https://example.com]' autolinks
  // 'https://example.com]'); when the link does form, tryLink
  // flattens the bare autolink back to plain text.
  return c === 32 || c === 9 || c === 10 || c === 40 || c === 42 || c === 95 || c === 126 || c === 60 || c === 91;
}

// Trim a bare-autolink candidate per the GFM rules: repeatedly drop
// trailing punctuation (? ! . , : ; * _ ~), an unbalanced trailing ')',
// and a trailing '&word;' (a whole bogus entity-looking suffix).
// marked's _backpedal for a bare URL: the kept prefix of the raw
// candidate is made of runs of chars that are not in
// ?!.,:;*_'\"~()& , balanced (...) groups (a '(' counts only when
// a ')' follows it inside the candidate), a bare '&' (one that does
// not start an entity), and runs of ?!.,:;*_'\"~) that are not at
// the very end of the candidate. So a trailing ')' or '.' is
// dropped, an unmatched '(' truncates the URL there, and a ']' is
// kept (it is not in the punctuation set).
function backpedalUrl(s) {
  const n = s.length;
  const isPunct = (c) => c === 63 || c === 33 || c === 46 || c === 44 || c === 58 ||
    c === 59 || c === 42 || c === 95 || c === 39 || c === 34 || c === 126 ||
    c === 40 || c === 41 || c === 38;
  const isPunctRun = (c) => c === 63 || c === 33 || c === 46 || c === 44 || c === 58 ||
    c === 59 || c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
  let p = 0;
  while (p < n) {
    const c = s.charCodeAt(p);
    if (!isPunct(c)) {
      while (p < n && !isPunct(s.charCodeAt(p))) p++;
      continue;
    }
    if (c === 40) {
      // '(' — keep only as a balanced group \([^)]*\).
      let q = p + 1;
      while (q < n && s.charCodeAt(q) !== 41) q++;
      if (q < n) { p = q + 1; continue; }
      break;
    }
    if (c === 38) {
      // '&' — keep unless it starts an entity (&alnum+; at the end).
      let q = p + 1;
      while (q < n && isAlnum(s.charCodeAt(q))) q++;
      if (q > p + 1 && q < n && s.charCodeAt(q) === 59) break;
      p++;
      continue;
    }
    // A run of ?!.,:;*_'\"~) — keep only when it is not the end.
    let q = p;
    while (q < n && isPunctRun(s.charCodeAt(q))) q++;
    if (q < n) { p = q; continue; }
    break;
  }
  return s.slice(0, p);
}

function trimAutolink(s) {
  let end = s.length;
  for (;;) {
    if (end === 0) break;
    const last = s.charCodeAt(end - 1);
    if (last === 59) {
      // ';' — check for a trailing '&word;' suffix to drop whole.
      let amp = -1;
      for (let k = end - 2; k >= 0; k--) {
        const c = s.charCodeAt(k);
        if (c === 38) {
          amp = k;
          break;
        }
        if (!(isAlnum(c) || c === 95)) break;
      }
      if (amp >= 0 && end - 1 - amp > 1) {
        end = amp;
        continue;
      }
      end--;
      continue;
    }
    if (last === 41) {
      let opens = 0;
      let closes = 0;
      for (let k = 0; k < end; k++) {
        const c = s.charCodeAt(k);
        if (c === 40) opens++;
        else if (c === 41) closes++;
      }
      if (closes > opens) {
        end--;
        continue;
      }
      break;
    }
    if (last === 63 || last === 33 || last === 46 || last === 44 || last === 58 ||
      last === 42 || last === 95 || last === 126) {
      end--;
      continue;
    }
    break;
  }
  return s.slice(0, end);
}

// Find the index of the ']' that closes the innermost open link
// opener, scanning from `from`. Bracket depth is tracked (nested
// '[' ... ']' pairs), backslash escapes are skipped, and code spans
// (matching backtick runs) are skipped whole, so a ']' inside a
// code span or a nested bracket does not end the link text.
// Returns -1 when there is no such ']'.
function linkTextEnd(str, from) {
  const n = str.length;
  let depth = 0;
  let i = from;
  while (i < n) {
    const c = str.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; }
    if (c === 96) {
      // A code-span-like token for label purposes (marked's label
      // regex): an opening run, non-backtick content, and the NEXT
      // backtick run of any length as the closer. So `` ``url` ``
      // is one token and the ']' after it closes the label, while
      // a real code span's ']' inside it is skipped.
      let j = i;
      while (j < n && str.charCodeAt(j) === 96) j++;
      let k = j;
      while (k < n && str.charCodeAt(k) !== 96) k++;
      if (k < n) {
        while (k < n && str.charCodeAt(k) === 96) k++;
        i = k;
      } else {
        i = j;
      }
      continue;
    }
    if (c === 91) { depth++; i++; continue; }
    if (c === 93) {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Try to match a bare www. / scheme:// autolink starting at str[i].
// Returns {text, href, next} or null.
// Whether a bare-URL match would swallow a link label's closing
// bracket: the matched text contains a ']' that is immediately
// followed by '(' (inline destination) or '[' (reference). In that
// case the '[' might still form a link, so the bare autolink must
// stay suppressed (it is created only when the link cannot form, or
// flattened by tryLink when it does). Otherwise the ']' is just part
// of the URL (marked keeps it: '[https://example.com]' autolinks
// 'https://example.com]'), and the autolink may be created eagerly.
function bareUrlSwallowsLinkClose(str, i, m) {
  const text = m.text;
  const close = text.indexOf(']');
  if (close < 0) return false;
  const after = str.charCodeAt(i + close + 1);
  return after === 40 || after === 91;
}

function matchBareUrl(str, i) {
  let scheme = null;
  let j = i;
  const rest = str.slice(i, i + 8).toLowerCase();
  const isWww = str.startsWith('www.', i);
  if (isWww) {
    scheme = 'http://';
    j = i + 4;
  } else if (rest.startsWith('http://')) {
    scheme = str.slice(i, i + 7);
    j = i + 7;
  } else if (rest.startsWith('https://')) {
    scheme = str.slice(i, i + 8);
    j = i + 8;
  } else if (rest.startsWith('ftp://')) {
    scheme = str.slice(i, i + 6);
    j = i + 6;
  } else {
    return null;
  }
  if (!autolinkBoundaryOk(str, i)) return null;
  // First character after the prefix must be a domain character.
  if (j >= str.length || !isDomainChar(str.charCodeAt(j))) return null;
  // The candidate runs to the next whitespace, '<', '>' or control char.
  let k = j;
  while (k < str.length) {
    const c = str.charCodeAt(k);
    if (c <= 32 || c === 60 || c === 62 || c === 127) break;
    k++;
  }
  let text = str.slice(i, k);
  text = backpedalUrl(text);
  const prefixLen = isWww ? 4 : scheme.length;
  if (text.length <= prefixLen) return null;
  const href = isWww ? 'http://' + text : text;
  return { text, href: cleanUrl(href), next: i + text.length };
}

// Bare xmpp autolink: xmpp:user@domain[/resource] — the only
// non-http/https/ftp scheme recognised bare. The resource is a
// single path segment (no '/' inside).
function matchXmpp(str, i) {
  if (str.slice(i, i + 5) !== 'xmpp:') return null;
  if (!autolinkBoundaryOk(str, i)) return null;
  const at = str.indexOf('@', i + 5);
  if (at === -1 || at === i + 5) return null;
  for (let k = i + 5; k < at; k++) {
    if (!isEmailLocalChar(str.charCodeAt(k))) return null;
  }
  const m = matchEmail(str, i + 5, at);
  if (!m) return null;
  let next = m.next;
  if (next < str.length && str.charCodeAt(next) === 47) {
    let r = next + 1;
    while (r < str.length) {
      const c = str.charCodeAt(r);
      if (c <= 32 || c === 60 || c === 62 || c === 47) break;
      r++;
    }
    if (r > next + 1) next = r;
  }
  let text = trimAutolink(str.slice(i, next));
  if (text.length === 0) return null;
  return { text, href: text, next: i + text.length };
}

// Try to match a bare email autolink whose '@' is at str[at].
// `localStart` is where the local part begins (caller scanned left).
// `hasUndOpener` is true when a '_' emphasis delimiter is open, so
// a trailing '_' in the domain closes it (truncate the domain)
// instead of invalidating the address. Returns {text, href, next,
// start} or null.
function matchEmail(str, localStart, at, hasUndOpener) {
  // Domain: labels of domain chars separated by '.', at least one dot,
  // no empty labels, must end with an alphanumeric character.
  let j = at + 1;
  if (j >= str.length || !isDomainChar(str.charCodeAt(j))) return null;
  let sawDot = false;
  while (j < str.length) {
    const c = str.charCodeAt(j);
    if (isDomainChar(c)) {
      j++;
    } else if (c === 46) {
      if (j + 1 >= str.length || !isDomainChar(str.charCodeAt(j + 1))) break;
      sawDot = true;
      j++;
    } else break;
  }
  if (!sawDot) return null;
  // The domain must end with an alphanumeric character. A trailing
  // '-' makes the whole address invalid (it is not a link at all,
  // not a shorter link plus trailing text). A trailing '_' also
  // invalidates, unless it closes an open '_' emphasis delimiter,
  // in which case the domain is truncated to the last alnum.
  let end = j;
  if (!isAlnum(str.charCodeAt(j - 1))) {
    if (str.charCodeAt(j - 1) === 95 && hasUndOpener) {
      let k = j - 1;
      while (k > at + 1 && str.charCodeAt(k) === 95) k--;
      if (!isAlnum(str.charCodeAt(k))) return null;
      end = k + 1;
    } else {
      return null;
    }
  }
  // If the local part starts with an escaped ASCII punctuation
  // character (a backslash right before it), the email is not an
  // autolink: the escape breaks the local part.
  if (localStart > 0 && str.charCodeAt(localStart - 1) === 92 &&
    isAsciiPunct(str.charCodeAt(localStart))) return null;
  let text = trimAutolink(str.slice(localStart, end));
  if (text.length === 0 || !text.includes('@')) return null;
  // A leading 'mailto:' at a boundary is part of the link.
  let start = localStart;
  if (localStart >= 7 && str.slice(localStart - 7, localStart) === 'mailto:' &&
    autolinkBoundaryOk(str, localStart - 7)) {
    start = localStart - 7;
    text = trimAutolink(str.slice(start, end));
  }
  const email = text.startsWith('mailto:') ? text.slice(7) : text;
  return { text, href: 'mailto:' + email, next: start + text.length, start };
}

// Try an autolink '<...>' starting at str[i] === '<'.
// Returns {kind:'link'|'html', ...} or null.
function matchAngle(str, i) {
  const n = str.length;
  let j = i + 1;
  // Scheme autolink: [a-zA-Z][a-zA-Z0-9+.-]{1,31}: followed by no
  // space, control or '<' until '>'.
  if (j < n && isAlpha(str.charCodeAt(j))) {
    let k = j;
    while (k < n) {
      const c = str.charCodeAt(k);
      if (isAlnum(c) || c === 43 || c === 46 || c === 45) {
        k++;
        continue;
      }
      break;
    }
    if (k - j >= 2 && k - j <= 32 && k < n && str.charCodeAt(k) === 58) {
      let m = k + 1;
      while (m < n) {
        const c = str.charCodeAt(m);
        if (c === 62) {
          const raw = str.slice(i + 1, m);
          return { kind: 'link', href: cleanUrl(raw), text: raw, next: m + 1 };
        }
        if (c <= 32 || c === 60) break;
        m++;
      }
    }
  }
  // Email autolink: local@domain with no space/control/'<' until '>'.
  {
    let k = j;
    let at = -1;
    while (k < n) {
      const c = str.charCodeAt(k);
      if (c === 62) break;
      if (c <= 32 || c === 60) break;
      if (c === 64 && at === -1) at = k;
      k++;
    }
    if (k < n && str.charCodeAt(k) === 62 && at !== -1) {
      const raw = str.slice(i + 1, k);
      let ok = at > j;
      for (let m = j; ok && m < at; m++) if (!isEmailLocalChar(str.charCodeAt(m))) ok = false;
      let dot = false;
      for (let m = at + 1; ok && m < k; m++) {
        const c = str.charCodeAt(m);
        if (c === 46) dot = true;
        else if (!isDomainChar(c)) ok = false;
      }
      if (ok && dot) {
        return { kind: 'link', href: 'mailto:' + raw, text: raw, next: k + 1 };
      }
    }
  }
  // Inline HTML: comment, PI, declaration, CDATA, or a tag.
  const html = matchInlineHtml(str, i);
  if (html) return { kind: 'html', text: html.text, next: html.next };
  return null;
}

// Match inline HTML starting at str[i] === '<'. Returns {text, next} or null.
function matchInlineHtml(str, i) {
  const n = str.length;
  // Comment: <!--> and <!---> are empty comments; otherwise
  // <!-- ... --> up to the first '-->'.
  if (str.startsWith('<!-->', i)) return { text: '<!-->', next: i + 5 };
  if (str.startsWith('<!--->', i)) return { text: '<!--->', next: i + 6 };
  if (str.startsWith('<!--', i)) {
    const j = str.indexOf('-->', i + 4);
    if (j === -1) return null;
    return { text: str.slice(i, j + 3), next: j + 3 };
  }
  // Processing instruction: <? ... ?>
  if (str.startsWith('<?', i)) {
    const j = str.indexOf('?>', i + 2);
    if (j === -1) return null;
    return { text: str.slice(i, j + 2), next: j + 2 };
  }
  // Declaration: <!A ... > (letter after !, up to '>')
  if (str.startsWith('<!', i) && i + 2 < n && isAlpha(str.charCodeAt(i + 2))) {
    let j = i + 2;
    while (j < n && str.charCodeAt(j) !== 62) j++;
    if (j >= n) return null;
    return { text: str.slice(i, j + 1), next: j + 1 };
  }
  // CDATA: <![CDATA[ ... ]]>
  if (str.startsWith('<![CDATA[', i)) {
    const j = str.indexOf(']]>', i + 9);
    if (j === -1) return null;
    return { text: str.slice(i, j + 3), next: j + 3 };
  }
  // Tag: </? name (attributes)* /?>
  // A closing tag takes no attributes: only whitespace then '>'.
  let j = i + 1;
  const isClose = j < n && str.charCodeAt(j) === 47;
  if (isClose) j++;
  if (j >= n || !isAlpha(str.charCodeAt(j))) return null;
  while (j < n) {
    const c = str.charCodeAt(j);
    if (isAlnum(c) || c === 45) j++;
    else break;
  }
  if (isClose) {
    let k = j;
    while (k < n) {
      const c = str.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) k++;
      else break;
    }
    if (k < n && str.charCodeAt(k) === 62) return { text: str.slice(i, k + 1), next: k + 1 };
    return null;
  }
  for (;;) {
    // Skip whitespace. An attribute must be preceded by whitespace:
    // if none was skipped and the next char is not '>' or '/', this
    // is not a tag.
    let k = j;
    while (k < n) {
      const c = str.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) k++;
      else break;
    }
    if (k >= n) return null;
    const c = str.charCodeAt(k);
    if (c === 62) return { text: str.slice(i, k + 1), next: k + 1 };
    if (c === 47) {
      if (k + 1 < n && str.charCodeAt(k + 1) === 62) return { text: str.slice(i, k + 2), next: k + 2 };
      return null;
    }
    if (k === j) return null;
    // Attribute name.
    if (!(isAlpha(c) || c === 95 || c === 58)) return null;
    j = k;
    while (j < n) {
      const d = str.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // Optional = value.
    k = j;
    while (k < n) {
      const d = str.charCodeAt(k);
      if (d === 32 || d === 9 || d === 10) k++;
      else break;
    }
    if (k < n && str.charCodeAt(k) === 61) {
      k++;
      while (k < n) {
        const d = str.charCodeAt(k);
        if (d === 32 || d === 9 || d === 10) k++;
        else break;
      }
      if (k >= n) return null;
      const q = str.charCodeAt(k);
      if (q === 34 || q === 39) {
        const qq = String.fromCharCode(q);
        k++;
        const end = str.indexOf(qq, k);
        if (end === -1) return null;
        j = end + 1;
      } else {
        // Unquoted value: no space, ", ', =, <, >, `.
        let m = k;
        while (m < n) {
          const d = str.charCodeAt(m);
          if (d <= 32 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          m++;
        }
        if (m === k) return null;
        j = m;
      }
    }
    // No '=': leave j at the end of the attribute name, so the next
    // loop iteration sees the whitespace before the following
    // attribute (or '>' / '/>').
  }
}

// ---------------------------------------------------------------------------
// Marked's emphasis mask
// ---------------------------------------------------------------------------
// Marked does not scan emphasis delimiters over the raw inline text:
// before tokenizing a run it builds a *masked* copy in which links,
// code spans, HTML tags and escaped punctuation are replaced by
// same-length filler (`[aaa...]`, `+`), so that `*`/`_`/`~` inside
// them cannot open or close emphasis. The mask is what makes
// `[docs ``url`](u) _c_ `d` leave `_c_` literal: the single backtick
// that was meant to close the `` `` `` run instead opens a code span
// in the mask that swallows `](u) _c_ `, so the emphasis scan never
// sees the `_c_` closer. The two patterns below are marked's own
// (rules.ts: anyPunctuationOutsideCode, blockSkip), transcribed for
// the mask only; the rest of this parser is written from scratch.
// The reference-link step of marked's mask is left out: a reference
// link that forms hides its text inside the link node anyway, and
// one that does not form is not masked by marked either.
const MASK_PUNCT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// Build marked's masked copy of an inline run. Every replacement
// keeps its length, so positions in the masked string line up with
// positions in the raw string.
function maskSrc(src) {
  let m = src.replace(MASK_PUNCT, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  m = m.replace(MASK_SKIP, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return m;
}

// Annotate every delimiter node in a node list with its mask flag:
// true when marked's mask hides the run, so the emphasis scans must
// skip it. The list covers the source range fullStr[lo..hi); a link
// (or image) node's children are annotated separately against the
// mask of the link text alone, because marked re-lexes link text as
// its own inline run — delimiters inside link text are NOT hidden
// by the outer run's mask. `needed` says whether this run saw a
// divergence-risk event at all (see the `stray` counter in
// scanInline); when it did not, the mask is the identity on every
// delimiter here and the work is skipped. The mask can only hide a
// delimiter when the text holds one and also holds a backtick, a
// '[', a '<' or a backslash; otherwise it is the identity and the
// work is skipped too.
function annotateMask(nodes, fullStr, lo, hi, needed) {
  const sub = fullStr.slice(lo, hi);
  let masked = null;
  if (needed &&
    (sub.indexOf('*') !== -1 || sub.indexOf('_') !== -1 || sub.indexOf('~') !== -1) &&
    (sub.indexOf('`') !== -1 || sub.indexOf('[') !== -1 || sub.indexOf('<') !== -1 || sub.indexOf('\\') !== -1)) {
    masked = maskSrc(sub);
  }
  for (const nd of nodes) {
    if (nd.t === 'delim') {
      let m = false;
      if (masked !== null) {
        const at = nd.pos - lo;
        for (let k = at; k < at + nd.n; k++) {
          if (masked[k] !== sub[k]) { m = true; break; }
        }
      }
      nd.masked = m;
    } else if (nd.t === 'link' && nd.labelStart !== undefined) {
      annotateMask(nd.children, fullStr, nd.labelStart, nd.labelEnd, nd.labelStray > 0);
    }
  }
}

// ---------------------------------------------------------------------------
// The inline scanner
// ---------------------------------------------------------------------------

// Compute the plain-text label of a node list (for shortcut/collapsed
// reference links).
function labelText(nodes) {
  let s = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'raw' || nd.t === 'code') s += nd.s;
    else if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') s += labelText(nd.children);
    else if (nd.t === 'link') s += labelText(nd.children);
    else if (nd.t === 'open') s += nd.img ? '![' : '[';
    else if (nd.t === 'delim') s += nd.ch.repeat(nd.n);
  }
  return s;
}

function altText(nodes) {
  return labelText(nodes);
}

// Try to form a link or image at the ']' at str[i], using the top opener
// on the stack. `nodes` is the current node list, `openers` the opener
// stack. On success the nodes list is spliced in place and {next} is
// returned; on failure null is returned.
// Whether the raw label text str[start..end] is fully consumable
// by marked's label regex: escapes, nested [...] pairs, a
// code-span-like token (a backtick run, non-backtick content, and
// the next backtick run of any length), or a backtick run
// immediately before the closing ']'. A stray backtick that is
// none of these makes the label unmatchable, so the link does not
// form (e.g. "[a `b` c` d](url)" stays literal).
function labelConsumable(str, start, end) {
  let i = start;
  while (i < end) {
    const c = str.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 91) {
      let depth = 1;
      let j = i + 1;
      while (j < end) {
        const d = str.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === 91) depth++;
        else if (d === 93) { depth--; if (depth === 0) break; }
        j++;
      }
      if (depth !== 0) return false;
      i = j + 1;
      continue;
    }
    if (c === 96) {
      let j = i;
      while (j < end && str.charCodeAt(j) === 96) j++;
      if (j === end) { i = j; continue; }
      let k = j;
      while (k < end && str.charCodeAt(k) !== 96) k++;
      if (k >= end) return false;
      while (k < end && str.charCodeAt(k) === 96) k++;
      i = k;
      continue;
    }
    if (c === 93) return false;
    i++;
  }
  return true;
}

function tryLink(str, i, op, nodes, openers, refs, stray) {
  // The label must be consumable by marked's label regex; a stray
  // backtick in it (not part of a code-span-like token and not
  // immediately before the ']') means the link does not form.
  if (!labelConsumable(str, op.src + 1, i)) return null;
  const children = nodes.slice(op.pos + 1);
  // A link cannot contain another (non-autolink) link: if the text
  // already holds a full link, this closer does not form a link.
  // An image may contain a link (its text becomes the alt text),
  // and autolinks inside link text are fine.
  if (!op.img) {
    for (const ch of children) {
      if (ch.t === 'link' && !ch.img && !ch.auto) return null;
    }
  }
  let dest = null;
  let title = null;
  let next = -1;
  const nc = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
  // The shortcut / collapsed label is the RAW source text between
  // the '[' and the ']' (escapes kept): labels match on raw text.
  const rawLabel = str.slice(op.src + 1, i);
  if (nc === 40) {
    // Inline link "(...)". If it does not parse, fall through to
    // the shortcut reference below.
    const r = parseInlineLink(str, i + 1);
    if (r) {
      dest = r.dest;
      title = r.title;
      next = r.next;
    }
  } else if (nc === 91) {
    // Full "[text][label]" or collapsed "[text][]" reference. If
    // the label parses but is not defined, do NOT fall back to the
    // shortcut: the opener stays literal so the label part may form
    // its own link. Only a missing/invalid label falls through.
    const lab = parseLabel(str, i + 1);
    if (lab) {
      let label = lab.label;
      if (label === '') label = rawLabel;
      if (label.length > 999) return null;
      const ref = refs.get(normalizeLabel(label));
      if (!ref) return null;
      dest = ref.dest;
      title = ref.title;
      next = lab.next;
    }
  }
  if (dest === null) {
    // Shortcut reference "[text]".
    const label = rawLabel;
    if (label.length === 0 || label.length > 999) return null;
    const ref = refs.get(normalizeLabel(label));
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    next = i + 1;
  }
  const href = cleanUrl(unescapeStr(dest));
  if (href === null) return null;
  // A bare autolink inside link text is plain text (marked's inLink
  // suppression): flatten bare-autolink children to their text.
  // Angle autolinks stay links (they nest inside link text).
  const flatChildren = [];
  for (const ch of children) {
    if (ch.t === 'link' && ch.auto && ch.bare) {
      for (const gc of ch.children) flatChildren.push(gc);
    } else {
      flatChildren.push(ch);
    }
  }
  const linkNode = {
    t: 'link',
    href,
    title: title === null ? null : unescapeStr(title),
    children: flatChildren,
    img: op.img,
    // Raw source range of the link text (for the emphasis mask:
    // marked re-lexes the link text as its own inline run, so its
    // delimiters are judged by the mask of this text alone).
    // labelStray counts the divergence-risk events seen while the
    // label was scanned (stray backticks and the like); the label
    // mask is only computed when that count is non-zero.
    labelStart: op.src + 1,
    labelEnd: i,
    labelStray: stray - (op.strayAtPush || 0),
  };
  // Replace the opener and everything after it with the link node.
  nodes.splice(op.pos, nodes.length - op.pos, linkNode);
  // Drop the matched opener and any openers nested inside the link text.
  for (let k = openers.length - 1; k >= 0; k--) {
    if (openers[k].pos >= op.pos) openers.splice(k, 1);
  }
  return { next };
}

// Parse a link label starting at str[i] === '['. Returns {label, next}
// or null. Labels may contain balanced brackets and backslash escapes.
function parseLabel(str, i) {
  let j = i + 1;
  let depth = 0;
  while (j < str.length) {
    const c = str.charCodeAt(j);
    if (c === 92 && j + 1 < str.length) {
      j += 2;
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) {
      if (depth === 0) return { label: str.slice(i + 1, j), next: j + 1 };
      depth--;
    }
    j++;
  }
  return null;
}

// Scan a string into inline nodes (links resolved, emphasis not yet).
function scanInline(str, refs) {
  const nodes = [];
  const openers = [];
  let buf = '';
  const n = str.length;
  let i = 0;
  // Count of divergence-risk events in this run: a backtick run
  // that could not form a code span, a '[...](...)' this link
  // parser rejected, or a '<...>' this tag parser rejected.
  // Marked's mask can only hide a delimiter this scanner left
  // visible when such an event happened (the mask pairs the stray
  // backtick across a link boundary, or matches a span this parser
  // rejected), so the mask is only computed for a run — or a link
  // label — that saw one. Most runs see none, which keeps the
  // mask's cost off the fast path.
  let stray = 0;
  const flush = () => {
    if (buf) {
      nodes.push({ t: 'text', s: buf });
      buf = '';
    }
  };
  const inLink = () => openers.length > 0;
  // True when some open '[' could still form a link (and so a bare
  // autolink inside it must stay plain text). A non-image opener
  // whose text already holds a full (non-autolink) link can never
  // form one — a link cannot contain a link — so it does not
  // suppress a bare autolink. An image opener always counts: an
  // image's text may hold a link and still form (as alt text).
  const hasLinkableOpener = () => {
    for (const op of openers) {
      if (op.img) return true;
      let doomed = false;
      for (let k = op.pos + 1; k < nodes.length; k++) {
        const ch = nodes[k];
        if (ch.t === 'link' && !ch.img && !ch.auto) { doomed = true; break; }
      }
      if (!doomed) return true;
    }
    return false;
  };
  // The last `len` characters of the inline content so far (trailing
  // text / delimiter nodes plus buf), or null when the content is
  // shorter or ends in a node that cannot hold plain text. A
  // delimiter run contributes its literal characters.
  const tailText = (len) => {
    let out = '';
    if (buf.length >= len) return buf.slice(buf.length - len);
    out = buf;
    let need = len - buf.length;
    for (let k = nodes.length - 1; k >= 0 && need > 0; k--) {
      const nd = nodes[k];
      if (nd.t === 'text') {
        const s = nd.s;
        if (s.length >= need) { out = s.slice(s.length - need) + out; need = 0; }
        else { out = s + out; need -= s.length; }
      } else if (nd.t === 'delim') {
        const s = nd.ch.repeat(nd.n);
        if (s.length >= need) { out = s.slice(s.length - need) + out; need = 0; }
        else { out = s + out; need -= s.length; }
      } else {
        return null;
      }
    }
    if (need > 0) return null;
    return out;
  };
  // Remove `len` characters from the end of the inline content.
  const removeTail = (len) => {
    let need = len;
    if (buf.length >= need) { buf = buf.slice(0, buf.length - need); return; }
    need -= buf.length;
    buf = '';
    for (let k = nodes.length - 1; k >= 0 && need > 0; k--) {
      const nd = nodes[k];
      if (nd.t === 'text') {
        if (nd.s.length > need) { nd.s = nd.s.slice(0, nd.s.length - need); need = 0; }
        else { need -= nd.s.length; nodes.splice(k, 1); }
      } else if (nd.t === 'delim') {
        if (nd.n > need) { nd.n -= need; need = 0; }
        else {
          need -= nd.n;
          nodes.splice(k, 1);
          const oi = openers.indexOf(nd);
          if (oi !== -1) openers.splice(oi, 1);
        }
      } else {
        break;
      }
    }
  };

  while (i < n) {
    const c = str.charCodeAt(i);

    // Backslash escape / hard break.
    if (c === 92) {
      if (i + 1 < n) {
        const d = str.charCodeAt(i + 1);
        if (d === 10) {
          flush();
          nodes.push({ t: 'br' });
          i += 2;
          // A hard break strips all leading spaces/tabs of the
          // next line.
          while (i < n && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (isAsciiPunct(d)) {
          // An escaped '&' must not merge with the following text into
          // an entity-looking sequence: keep it as its own text node so
          // the renderer escapes it to &amp;.
          if (d === 38) {
            flush();
            nodes.push({ t: 'text', s: '&' });
          } else {
            buf += str[i + 1];
          }
          i += 2;
          continue;
        }
      }
      buf += '\\';
      i++;
      continue;
    }

    // Code span.
    if (c === 96) {
      let j = i;
      while (j < n && str.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j;
      let found = -1;
      // Inside a link opener, the closing backtick run must come
      // before the ']' that closes the link text: a code span may
      // not swallow that ']' (marked's label regex consumes a
      // mismatched backtick run as literal text instead, so the
      // link still forms). Bound the scan at the link-text end,
      // found by scanning from the opener's '[' (so code spans
      // before this one are skipped whole).
      let limit = n;
      if (openers.length > 0) {
        const op = openers[openers.length - 1];
        const le = linkTextEnd(str, op.src + 1);
        // Only bound the scan when the link's closing ']' is still
        // ahead of this code span: if it is behind us (already
        // consumed, e.g. by a bare autolink), the opener is dead
        // and must not limit a later code span.
        if (le !== -1 && le > i) limit = le;
      }
      while (k < limit) {
        if (str.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && str.charCodeAt(m) === 96) m++;
          if (m - k === run) {
            found = k;
            break;
          }
          k = m;
        } else k++;
      }
      if (found === -1) {
        // A backtick run with no matching closer: literal text, and
        // a divergence risk — the mask may pair it with a later run.
        stray++;
        buf += str.slice(i, j);
        i = j;
        continue;
      }
      let content = str.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
        content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = found + run;
      continue;
    }

    // Emphasis / strikethrough delimiters.
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && str.charCodeAt(j) === c) j++;
      const run = j - i;
      const fl = flanking(str, i, run);
      let open;
      let close;
      if (c === 95) {
        open = fl.left && (!fl.right || (fl.before !== undefined && isUnicodePunct(fl.before)));
        close = fl.right && (!fl.left || (fl.after !== undefined && isUnicodePunct(fl.after)));
      } else {
        open = fl.left;
        close = fl.right;
      }
      flush();
      nodes.push({ t: 'delim', ch: String.fromCharCode(c), n: run, open, close, before: fl.before, after: fl.after, pos: i });
      i = j;
      continue;
    }

    // Link / image opener.
    if (c === 91 || (c === 33 && i + 1 < n && str.charCodeAt(i + 1) === 91)) {
      const img = c === 33;
      flush();
      nodes.push({ t: 'open', img });
      // `src` is the source index of the '[' (for the raw shortcut
      // label); `pos` is the index of the opener node.
      openers.push({ pos: nodes.length - 1, img, src: img ? i + 1 : i, strayAtPush: stray });
      i += img ? 2 : 1;
      continue;
    }

    // Link closer.
    if (c === 93) {
      if (openers.length === 0) {
        buf += ']';
        i++;
        continue;
      }
      // The link text must be in the node list (not the buffer) before
      // the link is formed.
      flush();
      const op = openers[openers.length - 1];
      const r = tryLink(str, i, op, nodes, openers, refs, stray);
      if (r) {
        i = r.next;
        continue;
      }
      // A '[...](...)' this parser rejected but the mask's link
      // regex may still match: a divergence risk for delimiters
      // inside the would-be label. (A failed '[...]' with no '('
      // after it cannot match the mask's link alternative.)
      if (i + 1 < n && str.charCodeAt(i + 1) === 40) stray++;
      openers.pop();
      buf += ']';
      i++;
      continue;
    }

    // Angle autolink / inline HTML. An angle autolink is recognised
    // even inside link text (it may nest inside a link); a bare
    // autolink is not (see below).
    if (c === 60) {
      const m = matchAngle(str, i);
      if (m) {
        flush();
        if (m.kind === 'link') {
          if (m.href === null) {
            buf += '<';
            i++;
            continue;
          }
          nodes.push({ t: 'link', href: m.href, title: null, children: [{ t: 'text', s: m.text }], img: false, auto: true });
        } else {
          nodes.push({ t: 'html', s: m.text });
          // Track unclosed <a> tags for the bare-autolink suppression.
          // NOTE: marked treats an inline <a ... /> as an OPENING tag
          // (the '/>' does not close it) — it suppresses later bare
          // autolinks until a </a> appears. The sole exception is the
          // bare '<a/>' (no space, no attributes), which is self-closing.
          const tag = m.text;
          if (tag.startsWith('</a') && (tag.length === 3 || isSpace(tag.charCodeAt(3)) || tag.charCodeAt(3) === 62 || tag.charCodeAt(3) === 47)) {
            htmlLinkOpen = false;
          } else if (tag.startsWith('<a') && (tag.length === 2 || isSpace(tag.charCodeAt(2)) || tag.charCodeAt(2) === 62 || tag.charCodeAt(2) === 47)) {
            if (tag !== '<a/>') htmlLinkOpen = true;
          }
        }
        i = m.next;
        continue;
      }
      // No angle autolink or tag here: literal '<', and a divergence
      // risk if a '>' follows (the mask's tag alternative may match
      // a span this parser rejected).
      if (i + 1 < n && str.charCodeAt(i + 1) !== 32 && str.indexOf('>', i + 1) !== -1) stray++;
      buf += '<';
      i++;
      continue;
    }

    // Entity / numeric character reference.
    if (c === 38) {
      if (i + 1 < n && str.charCodeAt(i + 1) === 35) {
        const dec = decodeNumericEntity(str, i);
        if (dec) {
          flush();
          nodes.push({ t: 'raw', s: escText(dec[0]) });
          i = dec[1];
          continue;
        }
      }
      let j = i + 1;
      while (j < n && isAlnum(str.charCodeAt(j))) j++;
      if (j > i + 1 && j < n && str.charCodeAt(j) === 59) {
        flush();
        nodes.push({ t: 'raw', s: str.slice(i, j + 1) });
        i = j + 1;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }

    // GFM bare autolinks (not after an unclosed inline <a> tag,
    // which suppresses them document-wide). They are created even
    // inside link text that could still form — marked only suppresses
    // them inside a link that HAS formed (inLink) — except when the
    // URL would swallow the label's closing bracket (see
    // bareUrlSwallowsLinkClose). When a link does form, tryLink
    // flattens its bare-autolink children back to plain text; when
    // it does not form, the autolink stands.
    if (!htmlLinkOpen) {
      if (c === 120) {
        const m = matchXmpp(str, i);
        if (m) {
          flush();
          nodes.push({ t: 'link', href: m.href, title: null, children: [{ t: 'text', s: m.text }], img: false, auto: true, bare: true });
          i = m.next;
          continue;
        }
      }
      if (c === 119 || c === 104 || c === 72 || c === 102 || c === 70) {
        const m = matchBareUrl(str, i);
        // Suppress only when the URL would swallow a link close AND
        // some opener could still form a link. An opener whose label
        // already holds a full link is doomed (a link cannot contain
        // a link), so the autolink must be created there — marked
        // autolinks it (e.g. 'https://sub.domain.example.io)]').
        if (m && m.href !== null && !(bareUrlSwallowsLinkClose(str, i, m) && hasLinkableOpener())) {
          flush();
          nodes.push({ t: 'link', href: m.href, title: null, children: [{ t: 'text', s: m.text }], img: false, auto: true, bare: true });
          i = m.next;
          continue;
        }
      }
      if (c === 64) {
        // Scan left in the source for the local part.
        let ls = i;
        while (ls > 0 && isEmailLocalChar(str.charCodeAt(ls - 1))) ls--;
        if (ls < i) {
          const localRaw = str.slice(ls, i);
          const localText = unescapeStr(localRaw);
          // The local part may span delimiter nodes ('_' / '*'
          // inside it), so compare against the tail text, not buf.
          if (tailText(localText.length) === localText) {
            // A trailing '_' in the domain may close an open '_'
            // emphasis delimiter (e.g. __...email__); allow the
            // domain to be truncated then, instead of invalidating.
            let hasUndOpener = false;
            for (const nd of nodes) {
              if (nd.t === 'delim' && nd.ch === '_' && nd.open) { hasUndOpener = true; break; }
            }
            const m = matchEmail(str, ls, i, hasUndOpener);
            if (m) {
              // Remove the local part (and a leading 'mailto:' if the
              // link includes it) from the content built so far.
              const take = m.start < ls ? 'mailto:' + localText : localText;
              if (tailText(take.length) === take) {
                removeTail(take.length);
                flush();
                nodes.push({ t: 'link', href: m.href, title: null, children: [{ t: 'text', s: m.text }], img: false, auto: true, bare: true });
                i = m.next;
                continue;
              }
            }
          }
        }
      }
    }

    // Newline: a hard break when preceded by two or more spaces
    // (the spaces are dropped); otherwise a soft break. A hard
    // break strips all leading spaces/tabs of the next line.
    if (c === 10) {
      let spaces = 0;
      while (spaces < buf.length && buf.charCodeAt(buf.length - 1 - spaces) === 32) spaces++;
      let hard = false;
      if (spaces >= 2) {
        buf = buf.slice(0, buf.length - spaces);
        flush();
        nodes.push({ t: 'br' });
        hard = true;
      } else {
        buf += '\n';
      }
      i++;
      if (hard) {
        while (i < n && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i++;
      }
      continue;
    }

    // Plain character.
    buf += str[i];
    i++;
  }
  flush();
  // Marked's emphasis mask, per inline run (see annotateMask): only
  // when this run saw a divergence-risk event.
  annotateMask(nodes, str, 0, n, stray > 0);
  return nodes;
}

// ---------------------------------------------------------------------------
// Emphasis processing — marked's emStrong algorithm for '*' and '_',
// the CommonMark delimiter stack for '~' (strikethrough).
// ---------------------------------------------------------------------------
// Marked does NOT use the standard delimiter stack for '*'/'_'. Its
// emStrong tokenizer tries the leftmost opener first and scans forward
// for its closer, keeping an `m` counter: the opener's length, grown
// by inner opener-only runs, shrunk by closer runs. A closer only
// matches when it exhausts `m`. A closer that can both open and close
// (or any closer when the opener can also close) is skipped by the
// rule of 3 (openerLen % 3 != 0 and (openerLen + closerLen) % 3 == 0),
// and its length goes to `f`, which the eventual match may consume.
// This is why `*a **b**c*` refuses the outer em (the inner `**`
// closer is skipped by the rule of 3, so `m` stays too large for the
// final `*`), while `*a **b** c*` accepts it (the inner closer is
// close-only, so it consumes `m`), and why `**a *b*c**` refuses the
// outer strong. The standard stack pairs the nearest opener first
// and gets all of these wrong.

// First / last source character of an inline node (for the flanking
// of leftover delimiter runs). A line break counts as '\n'.
function firstNodeChar(nd) {
  switch (nd.t) {
    case 'text': case 'code': case 'html': case 'raw':
      return nd.s.length > 0 ? nd.s[0] : undefined;
    case 'delim': return nd.ch;
    case 'open': return nd.img ? '!' : '[';
    case 'br': return '\n';
    case 'link': case 'em': case 'strong': case 'del':
      for (const c of nd.children) {
        const ch = firstNodeChar(c);
        if (ch !== undefined) return ch;
      }
      return undefined;
    default: return undefined;
  }
}
function lastNodeChar(nd) {
  switch (nd.t) {
    case 'text': case 'code': case 'html': case 'raw':
      return nd.s.length > 0 ? nd.s[nd.s.length - 1] : undefined;
    case 'delim': return nd.ch;
    case 'open': return '[';
    case 'br': return '\n';
    case 'link': case 'em': case 'strong': case 'del':
      for (let k = nd.children.length - 1; k >= 0; k--) {
        const ch = lastNodeChar(nd.children[k]);
        if (ch !== undefined) return ch;
      }
      return undefined;
    default: return undefined;
  }
}

// Open/close flags for a delimiter run of `ch` with the given
// neighbours (undefined = start/end of the text). Mirrors the
// flanking rules used by scanInline.
function delimFlags(ch, before, after) {
  const beforeSpace = before === undefined || isUnicodeSpace(before);
  const afterSpace = after === undefined || isUnicodeSpace(after);
  const beforePunct = before !== undefined && isUnicodePunct(before);
  const afterPunct = after !== undefined && isUnicodePunct(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  if (ch === '_') {
    return {
      open: left && (!right || (before !== undefined && isUnicodePunct(before))),
      close: right && (!left || (after !== undefined && isUnicodePunct(after))),
    };
  }
  return { open: left, close: right };
}

// Marked's emStrong scan for the opener delim node at nodes[oi].
// `y` is the full length of the opener's run (for the rule of 3);
// the `m` counter starts at the node's current length, which may
// be shorter than `y` when a failed opener was peeled back.
// Returns { closerIdx, used, tagLen } or null. `used` is how many
// characters of the closer run the match consumes; `tagLen` is 1
// for <em> and 2 for <strong>.
function findEmStrong(nodes, oi, y) {
  const op = nodes[oi];
  const k = op.n;
  const R = op.close; // the opener can also close
  // o: the character before the opener is the same delimiter (the
  // run was split by a preceding text token ending in it, e.g. an
  // escape). Then a both-flanking closer ends the scan with no match.
  let o = false;
  if (oi > 0) {
    const prev = nodes[oi - 1];
    if (prev.t === 'text' && prev.s.length > 0 && prev.s[prev.s.length - 1] === op.ch) o = true;
  }
  let m = k, f = 0;
  // Whether this is the first same-character delimiter run met in
  // the scan. Marked's closer regex skips a single `*` enclosed in
  // `__...__` (and a single `_` enclosed in `**...**`) when it is
  // the first match of the scan: the regex's leading alternation
  // consumes `__...*...__` as a chunk, so the enclosed delimiter
  // never touches `m`. It only applies at the start of the scan
  // (the alternation is anchored) and only to a single delimiter.
  let firstSame = true;
  const other = op.ch === '*' ? '_' : '*';
  const isEnclosedSingle = (j) => {
    const nd = nodes[j];
    if (nd.n !== 1) return false;
    // Nearest preceding delimiter must be an other-character run
    // of length >= 2, and it must be the first delimiter after the
    // opener (no delimiter between the opener and it). Masked
    // delimiters are invisible to the scan, so they do not count.
    let p = -1;
    for (let q = j - 1; q > oi; q--) {
      if (nodes[q].t === 'delim' && !nodes[q].masked) { p = q; break; }
    }
    if (p < 0 || nodes[p].ch !== other || nodes[p].n < 2) return false;
    for (let q = p - 1; q > oi; q--) {
      if (nodes[q].t === 'delim' && !nodes[q].masked) return false;
    }
    // Nearest following delimiter must be an other-character run
    // of length >= 2.
    for (let q = j + 1; q < nodes.length; q++) {
      if (nodes[q].t === 'delim' && !nodes[q].masked) {
        return nodes[q].ch === other && nodes[q].n >= 2;
      }
    }
    return false;
  };
  for (let j = oi + 1; j < nodes.length; j++) {
    const nd = nodes[j];
    if (nd.t !== 'delim' || nd.ch !== op.ch) continue;
    // A delimiter the mask hides is invisible to the scan: it
    // neither opens nor closes, and it does not end the "first
    // same-character delimiter" stretch.
    if (nd.masked) continue;
    const b = nd.n;
    if (firstSame && isEnclosedSingle(j)) { firstSame = false; continue; }
    firstSame = false;
    if (nd.open && !nd.close) { m += b; continue; }
    if (!nd.close) continue;
    const isBoth = nd.open && nd.close;
    if (o && isBoth) return null;
    if ((isBoth || R) && y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    m -= b;
    if (m > 0) continue;
    const used = Math.min(b, b + m + f);
    const take = Math.min(k, used);
    return { closerIdx: j, used, tagLen: take % 2 === 1 ? 1 : 2 };
  }
  return null;
}

// '*' and '_' emphasis by marked's emStrong scan (opener-first).
function processEmStrong(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.t !== 'delim' || (nd.ch !== '*' && nd.ch !== '_')) { i++; continue; }
    if (!nd.open) { i++; continue; }
    // Try this opener; if it fails and the run has more than one
    // character, peel off one literal character and retry the
    // remainder (marked's lexer consumes one delimiter as text and
    // retries the next one, so `**foo*` becomes `*<em>foo</em>`).
    // `y` stays the full run length for the rule of 3.
    const y = nd.n;
    let m = null;
    while (nd.open) {
      m = findEmStrong(nodes, i, y);
      if (m) break;
      if (nd.n <= 1) break;
      nodes.splice(i, 0, { t: 'text', s: nd.ch });
      nd.n -= 1;
      const fl = delimFlags(nd.ch, nd.ch, nd.after);
      nd.open = fl.open;
      nd.close = fl.close;
      nd.before = nd.ch;
      i += 1;
    }
    if (!m) { i++; continue; }
    const op = nd;
    const closer = nodes[m.closerIdx];
    const tag = m.tagLen === 2 ? 'strong' : 'em';
    const children = nodes.slice(i + 1, m.closerIdx);
    // Leftover opener characters (k - tagLen) and leftover closer
    // characters (used - tagLen) stay INSIDE the new node (marked
    // slices only tagLen characters off each end of the raw span);
    // the closer run's tail (b - used) stays outside, after it.
    const firstCh = children.length > 0 ? firstNodeChar(children[0]) : undefined;
    const lastCh = children.length > 0 ? lastNodeChar(children[children.length - 1]) : undefined;
    if (op.n > m.tagLen) {
      const fl = delimFlags(op.ch, undefined, firstCh);
      children.unshift({ t: 'delim', ch: op.ch, n: op.n - m.tagLen, open: fl.open, close: fl.close, before: undefined, after: firstCh, masked: op.masked });
    }
    if (m.used > m.tagLen) {
      const fl = delimFlags(op.ch, lastCh, undefined);
      children.push({ t: 'delim', ch: op.ch, n: m.used - m.tagLen, open: fl.open, close: fl.close, before: lastCh, after: undefined, masked: closer.masked });
    }
    const emNode = { t: tag, children };
    const repl = [emNode];
    if (closer.n > m.used) {
      const fl = delimFlags(op.ch, op.ch, closer.after);
      repl.push({ t: 'delim', ch: op.ch, n: closer.n - m.used, open: fl.open, close: fl.close, before: op.ch, after: closer.after, masked: closer.masked });
    }
    nodes.splice(i, m.closerIdx - i + 1, ...repl);
    // Marked re-tokenizes the matched text, so nested emphasis
    // inside the new node is processed now.
    processEmphasis(emNode.children);
    // Continue after the new node; a leftover closer is re-examined
    // as a possible opener.
    i = i + 1;
  }
}

// '~' strikethrough by the CommonMark delimiter stack (same-length
// runs of 1 or 2; a run of 3+ never forms a del).
function processDel(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' || nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') processDel(nd.children);
  }
  const openers = [];
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.t !== 'delim' || nd.ch !== '~') { i++; continue; }
    // A masked tilde is invisible to the scan: it neither opens
    // nor closes.
    if (nd.masked) { i++; continue; }
    if (nd.close) {
      let oi = -1;
      for (let k = openers.length - 1; k >= 0; k--) {
        const op = openers[k];
        if (op.ch !== '~' || !op.open) continue;
        if (nd.n >= 3 || op.n !== nd.n) continue;
        oi = k;
        break;
      }
      if (oi >= 0) {
        const op = openers[oi];
        const use = op.n;
        const opIdx = nodes.indexOf(op);
        const children = nodes.slice(opIdx + 1, i);
        const delNode = { t: 'del', children };
        op.n -= use;
        nd.n -= use;
        const repl = [];
        if (op.n > 0) repl.push(op);
        repl.push(delNode);
        if (nd.n > 0) repl.push(nd);
        nodes.splice(opIdx, i - opIdx + 1, ...repl);
        for (let k = openers.length - 1; k >= 0; k--) {
          if (nodes.indexOf(openers[k]) === -1) openers.splice(k, 1);
        }
        processEmphasis(delNode.children);
        i = opIdx + repl.length - (nd.n > 0 ? 1 : 0);
        continue;
      }
    }
    if (nd.open) openers.push(nd);
    i++;
  }
}

function processEmphasis(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link') processEmphasis(nd.children);
  }
  processEmStrong(nodes);
  processDel(nodes);
  // Any delimiter left over is literal text.
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'delim') nodes[k] = { t: 'text', s: nd.ch.repeat(nd.n) };
  }
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInline(nodes, out) {
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text':
        out.push(escText(nd.s));
        break;
      case 'raw':
        out.push(nd.s);
        break;
      case 'code':
        out.push('<code>' + escAll(nd.s) + '</code>');
        break;
      case 'html':
        out.push(nd.s);
        break;
      case 'br':
        out.push('<br>');
        break;
      case 'em':
        out.push('<em>');
        renderInline(nd.children, out);
        out.push('</em>');
        break;
      case 'strong':
        out.push('<strong>');
        renderInline(nd.children, out);
        out.push('</strong>');
        break;
      case 'del':
        out.push('<del>');
        renderInline(nd.children, out);
        out.push('</del>');
        break;
      case 'open':
        out.push(nd.img ? '![' : '[');
        break;
      case 'delim':
        out.push(escText(nd.ch.repeat(nd.n)));
        break;
      case 'link': {
        if (nd.img) {
          const alt = altText(nd.children);
          out.push('<img src="' + escAttr(nd.href) + '" alt="' + escAttr(alt) + '"');
          if (nd.title !== null && nd.title !== undefined) out.push(' title="' + escAttr(nd.title) + '"');
          out.push('>');
        } else {
          out.push('<a href="' + escAttr(nd.href) + '"');
          if (nd.title !== null && nd.title !== undefined) out.push(' title="' + escAttr(nd.title) + '"');
          out.push('>');
          renderInline(nd.children, out);
          out.push('</a>');
        }
        break;
      }
    }
  }
}

// Parse inline content of a paragraph / heading / table cell to HTML.
function parseInlineToHtml(text, refs) {
  const nodes = scanInline(text, refs);
  processEmphasis(nodes);
  const out = [];
  renderInline(nodes, out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
// Node shapes:
//  {t:'doc', children, refs}
//  {t:'para', lines}             raw lines (container markers stripped)
//  {t:'heading', level, lines}
//  {t:'code', fenced, fenceChar, fenceLen, info, lines}
//  {t:'html', lines, endType}   endType 1-7 (HTML block conditions)
//  {t:'hr'}
//  {t:'quote', children}
//  {t:'list', ordered, start, delim, tight, loose, children}
//  {t:'item', children, contentCol, endsBlank}
//  {t:'table', align, header, rows}  header/rows: arrays of cell strings

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Split a table row line into cells on unescaped '|' (a '|' is a
// separator unless preceded by an odd run of backslashes; code spans
// do NOT protect a bare '|' — marked splits inside them, and the
// table-level '\|' escape is resolved here before inline parsing).
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  let firstSplit = false;
  let lastSplitAt = -1;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 124) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && line.charCodeAt(j) === 92) {
        bs++;
        j--;
      }
      if (bs % 2 === 1) {
        // Escaped pipe: drop the escaping backslash, keep a literal '|'.
        cur = cur.slice(0, -1) + '|';
        i++;
        continue;
      }
      // A leading pipe is a border (not an empty first cell) when
      // everything before it is whitespace, even after leading spaces.
      if (cells.length === 0 && cur.trim() === '') firstSplit = true;
      lastSplitAt = i;
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  cells.push(cur);
  let start = 0;
  let end = cells.length;
  if (firstSplit) start = 1;
  // A trailing pipe is a border (not an empty last cell) when
  // everything after it is whitespace, even with trailing spaces.
  if (lastSplitAt >= 0 && cells[cells.length - 1].trim() === '') end = cells.length - 1;
  const out = [];
  for (let k = start; k < end; k++) out.push(cells[k].trim());
  return out;
}

// If `line` is a table delimiter row, return the alignment per column.
function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Skip spaces/tabs/newlines (used inside link reference definitions).
function skipDefSpace(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse one link reference definition starting at text[i] === '['.
// Returns {label, dest, title, next} or null. `next` is the index just
// past the definition (at end of line).
function parseDefinition(text, i) {
  const n = text.length;
  let j = i + 1;
  let label = '';
  let depth = 0;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < n && text.charCodeAt(j + 1) !== 10) {
      label += text[j] + text[j + 1];
      j += 2;
      continue;
    }
    if (c === 91) {
      // An unescaped "[" inside a definition label makes the
      // definition invalid (a label may not contain one).
      return null;
    }
    if (c === 93) {
      if (depth === 0) break;
      depth--;
      label += ']';
      j++;
      continue;
    }
    label += text[j];
    j++;
  }
  if (j >= n || text.charCodeAt(j) !== 93) return null;
  if (label.length === 0 || label.length > 999) return null;
  // A label that normalises to nothing (all whitespace) is invalid.
  if (normalizeLabel(label) === '') return null;
  j++;
  if (j >= n || text.charCodeAt(j) !== 58) return null;
  j++;
  j = skipDefSpace(text, j);
  const d = parseDest(text, j);
  if (!d) return null;
  // A title must be separated from the destination by whitespace
  // (a space, tab, or line ending).
  j = skipDefSpace(text, d.next);
  const hadSpace = j > d.next;
  let title = null;
  if (hadSpace && j < n && (text[j] === '"' || text[j] === "'" || text[j] === '(')) {
    const t = parseTitle(text, j);
    if (t) {
      // After a title there may only be spaces/tabs, then a line
      // ending (or the end of the text).
      let k = t.next;
      while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
      if (k >= n || text.charCodeAt(k) === 10) {
        return { label, dest: d.dest, title: t.title, next: k };
      }
      // A title followed by other text on the same line is not a
      // title at all: fall through to the no-title definition.
    } else {
      // A malformed title invalidates the whole definition.
      return null;
    }
  }
  // No title: the definition ends after the destination's line.
  let k = d.next;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k < n && text.charCodeAt(k) !== 10) return null;
  return { label, dest: d.dest, title: null, next: k };
}

// Strip leading link reference definitions from a paragraph's lines.
// Returns the remaining lines (the paragraph content).
// Strip leading link reference definitions from a paragraph's lines,
// registering them in `refs` when `register` is true. Returns the
// remaining lines (a new array). A dry run (register=false) parses the
// same definitions but does not register them: used by the table probe,
// which runs on a still-growing paragraph and must not register a
// definition that later lines invalidate.
function extractDefinitions(lines, refs, register = true) {
  const text = lines.join('\n');
  const n = text.length;
  let pos = 0;
  let consumed = 0;
  for (;;) {
    let p = pos;
    let indent = 0;
    while (p < n && text.charCodeAt(p) === 32 && indent < 3) {
      p++;
      indent++;
    }
    if (p >= n || text.charCodeAt(p) !== 91) break;
    const def = parseDefinition(text, p);
    if (!def) break;
    // Labels match on RAW text (escapes kept): a reference "[foo\!]"
    // matches a definition "[foo\!]" but not "[foo!]".
    const norm = normalizeLabel(def.label);
    if (register && norm && !refs.has(norm)) {
      refs.set(norm, { dest: unescapeStr(def.dest), title: def.title === null ? null : unescapeStr(def.title) });
    }
    let next = def.next;
    if (next < n && text.charCodeAt(next) === 10) next++;
    pos = next;
    consumed = pos;
  }
  if (consumed === 0) return lines;
  const rest = text.slice(consumed);
  return rest === '' ? [] : rest.split('\n');
}

// ---------------------------------------------------------------------------
// Marked's list-item collection rule (used by the fenced-code absorption
// decision in parseBlocks): when a line fails a list item's indent, the
// item ends — unless the line is absorbed verbatim into the item text.
// A line is NOT absorbed when it starts a block at the item's level
// (fence / ATX heading / HTML block types 1-6 / blockquote / thematic
// break, at most n = clamp(R-1, 0, 3) leading spaces, R = the item's
// content indent), or when the previous item-text line forces the end
// (it was blank, it starts at column >= 4, or it starts a fence /
// heading / HTML / thematic break). The tests below mirror marked's
// list() interrupt regexes, which count literal spaces only — a tab
// first means no match.
// ---------------------------------------------------------------------------

// Leading spaces (literal ' ' only) of a string.
function leadSpaces(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i;
}

// Leading whitespace width of a string, counting each tab as 4 spaces
// (marked's `m.replace(/\t/g, '    ')` in the same condition).
function leadWidth4(s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) w++;
    else if (c === 9) w += 4;
    else break;
  }
  return w;
}

function fenceBeginStr(s, n) {
  const sp = leadSpaces(s);
  if (sp > n) return false;
  const ch = s[sp];
  if (ch !== '`' && ch !== '~') return false;
  let p = sp;
  while (p < s.length && s[p] === ch) p++;
  return p - sp >= 3;
}

function headingBeginStr(s, n) {
  const sp = leadSpaces(s);
  if (sp > n) return false;
  let p = sp;
  let h = 0;
  while (p < s.length && s[p] === '#') {
    h++;
    p++;
  }
  if (h === 0 || h > 6) return false;
  return p >= s.length || s[p] === ' ' || s[p] === '\t';
}

function quoteBeginStr(s, n) {
  const sp = leadSpaces(s);
  return sp <= n && s[sp] === '>';
}

function hrBeginStr(s, n) {
  const sp = leadSpaces(s);
  if (sp > n) return false;
  const ch = s[sp];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let p = sp;
  let count = 0;
  while (p < s.length) {
    const c = s[p];
    if (c === ' ' || c === '\t') {
      p++;
      continue;
    }
    if (c !== ch) return false;
    count++;
    p++;
  }
  return count >= 3;
}

// HTML block begin, types 1-6 only (a type-7 complete tag does not
// interrupt a list item in marked). Mirrors tryHtmlStart's type checks.
function htmlBeginStr(s, n) {
  const sp = leadSpaces(s);
  if (sp > n) return false;
  const rest = s.slice(sp);
  if (!rest.startsWith('<')) return false;
  const low = rest.toLowerCase();
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (low.startsWith('<' + tag)) {
      const after = rest[1 + tag.length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') return true;
    }
  }
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<?')) return true;
  if (rest.startsWith('<!') && rest.length > 2 && isAlpha(rest.charCodeAt(2))) return true;
  if (rest.startsWith('<![CDATA[')) return true;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The block parser: state and cursor helpers
// ---------------------------------------------------------------------------

function parseBlocks(src) {
  const normalized = src.replace(/\r\n?/g, '\n');
  const inputEndsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const root = { t: 'doc', children: [], refs: new Map() };
  // Parser state (kept in one object so the helpers below can share it).
  const S = {
    lines,
    line: '',
    pos: 0,
    col: 0,
    // Blockquote markers matched on the current line (for the tab
    // column in expandLeadingTabs: only the first marker counts).
    bqMatched: 0,
    // Absolute column of the innermost '>' matched on this line
    // (-1 when none): the tab column is relative to it.
    bqCol: -1,
    stack: [root],
    root,
    refs: root.refs,
    blankPending: false,
    // A blank line that was truly blank (raw line blank, not merely
    // blank past a container marker): separates list items.
    blankPendingStructural: false,
    lineIdx: 0,
    prevLazy: false,
    // Index of the last real input line; an HTML block whose last line
    // is this line (and the input ends with a newline) keeps a trailing
    // newline when rendered.
    lastLineIdx: lines.length - 1,
    inputEndsWithNewline,
  };

  const tip = () => S.stack[S.stack.length - 1];
  const parentOfTip = () => S.stack[S.stack.length - 2];

  // Consume up to `n` columns of spaces/tabs from the cursor. A tab that
  // straddles the target is split into spaces (the remainder stays in
  // the line) — unless `wholeTab` is set, in which case a tab is always
  // consumed whole (code-block indent stripping never splits a tab).
  // Returns the columns actually consumed.
  function advanceCols(n, wholeTab) {
    let need = n;
    while (need > 0 && S.pos < S.line.length) {
      const c = S.line.charCodeAt(S.pos);
      if (c === 32) {
        S.pos++;
        S.col++;
        need--;
      } else if (c === 9) {
        const w = 4 - (S.col % 4);
        if (wholeTab || w <= need) {
          S.pos++;
          S.col += w;
          need -= w;
        } else {
          S.line = S.line.slice(0, S.pos) + ' '.repeat(w) + S.line.slice(S.pos + 1);
          S.pos++;
          S.col++;
          need--;
        }
      } else break;
    }
    return n - need;
  }

  // Expand leading tabs (from the cursor) to spaces in S.line, so a
  // tab that an indent-strip did not consume becomes spaces in fenced
  // code content. Only applies when some indent was already stripped
  // (S.pos > 0); a tab at the very start of the line stays a literal
  // tab. S.pos stays at the start of the expanded spaces (they are
  // part of the content); S.col advances past them.
  // NOTE: marked's tab column is relative to the innermost '>'
  // marker matched on the line: a tab after '> ' counts from the
  // '>' itself, so leading list-item indent before the marker does
  // not shift the tab stops. S.col itself keeps the absolute column.
  function expandLeadingTabs() {
    if (S.pos === 0) return;
    let p = S.pos;
    let col = S.bqCol >= 0 ? S.col - S.bqCol : S.col;
    if (col < 0) col = 0;
    let absCol = S.col;
    while (p < S.line.length) {
      const c = S.line.charCodeAt(p);
      if (c === 32) {
        p++;
        col++;
        absCol++;
      } else if (c === 9) {
        const w = 4 - (col % 4);
        S.line = S.line.slice(0, p) + ' '.repeat(w) + S.line.slice(p + 1);
        p += w;
        col += w;
        absCol += w;
      } else break;
    }
    S.col = absCol;
  }

  // Whether the tip block sits inside a list item or blockquote.
  // Only then does marked expand a leading tab before the fence
  // lexer sees the line (list item text: J-expansion + slice;
  // blockquote: marker-whitespace J-expansion). A fenced code block
  // at the top level goes straight to the fence lexer, whose Dt
  // strips up to fenceIndent leading whitespace CHARACTERS and
  // never expands a tab — so a tab there must stay literal.
  function inContainer() {
    for (let k = 1; k < S.stack.length - 1; k++) {
      if (S.stack[k].t === 'item' || S.stack[k].t === 'quote') return true;
    }
    return false;
  }

  // Columns of indentation (spaces/tabs) from the cursor.

  // Columns of indentation (spaces/tabs) from the cursor.
  function indentAt() {
    let p = S.pos;
    let col = S.col;
    while (p < S.line.length) {
      const c = S.line.charCodeAt(p);
      if (c === 32) {
        p++;
        col++;
      } else if (c === 9) {
        col += 4 - (col % 4);
        p++;
      } else break;
    }
    return col - S.col;
  }

  function isBlankFromHere() {
    for (let p = S.pos; p < S.line.length; p++) {
      const c = S.line.charCodeAt(p);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  // Match one container (quote / list / item) against the line.
  // Returns true on a match (cursor advanced past the marker).
  // A blank line matches every open container: it never closes one.
  function matchContainer(b) {
    if (b.t === 'list') return true; // lists are transparent
    if (b.t === 'quote') {
      // A blank line ends a blockquote (marked behavior): a quote
      // does not match a line that is blank past the outer containers.
      if (isBlankFromHere()) return false;
      const savePos = S.pos;
      const saveCol = S.col;
      const saveLine = S.line;
      advanceCols(3);
      if (S.pos < S.line.length && S.line.charCodeAt(S.pos) === 62) {
        S.bqCol = S.col;
        S.pos++;
        S.col++;
        if (S.pos < S.line.length) {
          const c = S.line.charCodeAt(S.pos);
          if (c === 32) {
            S.pos++;
            S.col++;
          } else if (c === 9) {
            // A tab after '>': expand it on quote-relative tab
            // stops (J with b.length) and consume one space — the
            // marker space — leaving the rest as content. E.g.
            // '>\tfoo' yields 2 spaces + 'foo' (J gives 3, minus
            // 1). advanceCols(1) would swallow the whole tab.
            expandLeadingTabs();
            S.pos++;
            S.col++;
          }
        }
        S.bqMatched++;
        return true;
      }
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return false;
    }
    // list item: the line must be indented to the item's content
    // indent, measured from the current line's container-content
    // start (b.contentCol is relative, since the container markers
    // differ in width from line to line).
    if (isBlankFromHere()) return true;
    if (indentAt() < b.contentCol) return false;
    advanceCols(b.contentCol);
    return true;
  }

  // Close blocks from the top of the stack down to (but not including)
  // `depth`, finalizing each.
  function closeTo(depth) {
    while (S.stack.length > depth) {
      const b = S.stack.pop();
      finalize(b);
    }
  }

  function finalize(b) {
    if (b.t === 'para') {
      b.lines = extractDefinitions(b.lines, S.refs);
      if (b.lines.length === 0) {
        // The paragraph was only link reference definitions: remove it.
        const parent = S.stack[S.stack.length - 1];
        if (parent) {
          const idx = parent.children.indexOf(b);
          if (idx >= 0) parent.children.splice(idx, 1);
        }
      }
    }
    if (b.t === 'code') {
      // A fenced code block drops exactly one trailing blank line; an
      // indented code block drops all trailing blank lines.
      if (b.fenced) {
        if (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      } else {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
    }
    if (b.t === 'html') {
      // An HTML block keeps a trailing newline after its last line
      // when it ended by its terminator (types 1-5) and the next line
      // is not blank, or when it runs to the end of the input and the
      // input ends with a newline. A block ended by a blank line or by
      // a container closing keeps no trailing newline.
      const atEofWithNl = b.lastLine === S.lastLineIdx && S.inputEndsWithNewline;
      if (b.endedByTerminator) {
        // The next line counts as non-blank when it has any content
        // at all — a whitespace-only line (spaces/tabs) is not blank
        // here, only a truly empty line is. But container markers
        // are not content: a lone '>' line (empty after the quote
        // marker) is blank for this purpose, so an HTML block
        // followed by one keeps no trailing newline. Only strip
        // markers when a '>' is actually present; a line with no
        // marker keeps the old length check (whitespace counts).
        const nextLine = b.lastLine < S.lastLineIdx ? S.lines[b.lastLine + 1] : '';
        let p = 0;
        while (p < nextLine.length && (nextLine.charCodeAt(p) === 32 || nextLine.charCodeAt(p) === 9)) p++;
        let nextNonBlank;
        if (p < nextLine.length && nextLine.charCodeAt(p) === 62) {
          // Strip quote markers ('>' plus one following space/tab
          // each). Whatever remains — including trailing spaces —
          // is content.
          for (;;) {
            p++; // consume '>'
            if (p < nextLine.length && (nextLine.charCodeAt(p) === 32 || nextLine.charCodeAt(p) === 9)) p++;
            let q = p;
            while (q < nextLine.length && (nextLine.charCodeAt(q) === 32 || nextLine.charCodeAt(q) === 9)) q++;
            if (q < nextLine.length && nextLine.charCodeAt(q) === 62) { p = q; continue; }
            break;
          }
          nextNonBlank = b.lastLine < S.lastLineIdx && p < nextLine.length;
        } else {
          nextNonBlank = b.lastLine < S.lastLineIdx && nextLine.length > 0;
        }
        b.trailingNl = nextNonBlank || atEofWithNl;
      } else {
        b.trailingNl = atEofWithNl;
      }
    }
  }

  // Add a new block node as a child of the tip, marking the enclosing
  // list loose when a blank line separated it from the previous block
  // inside the same list item. A list itself never takes non-item
  // children: skip over a trailing list to its parent.
  function addBlock(node) {
    let t = tip();
    while (t.t === 'list') {
      const idx = S.stack.indexOf(t);
      t = S.stack[idx - 1];
    }
    if (S.blankPending && t.t === 'item' && t.children.length > 0) {
      const idx = S.stack.indexOf(t);
      const list = S.stack[idx - 1];
      if (list && list.t === 'list') list.loose = true;
    }
    t.children.push(node);
    return node;
  }

  // --- Block-start checks (each saves/restores the cursor on failure) ---

  // ATX heading. Returns the heading node or null.
  function tryAtheading() {
    const savePos = S.pos;
    const saveCol = S.col;
    const saveLine = S.line;
    advanceCols(3);
    let p = S.pos;
    let hashes = 0;
    while (p < S.line.length && S.line.charCodeAt(p) === 35) {
      hashes++;
      p++;
    }
    if (hashes === 0 || hashes > 6) {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return null;
    }
    if (p < S.line.length) {
      const c = S.line.charCodeAt(p);
      if (c !== 32 && c !== 9) {
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        return null;
      }
    }
    // Content: strip trailing spaces, then a closing sequence of #'s
    // preceded by a space (the space after the opening hashes counts),
    // then leading spaces.
    let content = S.line.slice(p);
    content = content.replace(/[ \t]+$/, '');
    content = content.replace(/[ \t]+#+$/, '');
    content = content.replace(/^[ \t]+/, '');
    S.pos = S.line.length;
    S.col = S.col + (S.line.length - savePos);
    return { t: 'heading', level: hashes, lines: [content] };
  }

  // Fenced code block start. Returns {fenceChar, fenceLen, info} or null.
  function tryFencedStart() {
    const savePos = S.pos;
    const saveCol = S.col;
    const saveLine = S.line;
    // The fence's indent, relative to the container-content start:
    // content lines lose this many columns (the container markers
    // differ in width from line to line, so an absolute column is wrong).
    const baseCol = S.col;
    advanceCols(3);
    // The fence's own indent: up to that many columns are stripped
    // from every content line of the fenced block.
    const fenceIndent = S.col - baseCol;
    if (S.pos >= S.line.length) {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return null;
    }
    const ch = S.line[S.pos];
    if (ch !== '`' && ch !== '~') {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return null;
    }
    let p = S.pos;
    while (p < S.line.length && S.line[p] === ch) p++;
    const len = p - S.pos;
    if (len < 3) {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return null;
    }
    const info = S.line.slice(p).trim();
    if (ch === '`' && info.includes('`')) {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return null;
    }
    S.pos = S.line.length;
    return { fenceChar: ch, fenceLen: len, info, fenceIndent };
  }

  // Is the line (from the cursor) a closing fence for `code`?
  function isClosingFence(code) {
    const savePos = S.pos;
    const saveCol = S.col;
    const saveLine = S.line;
    advanceCols(3);
    let p = S.pos;
    while (p < S.line.length && S.line[p] === code.fenceChar) p++;
    const len = p - S.pos;
    if (len < code.fenceLen) {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return false;
    }
    for (let q = p; q < S.line.length; q++) {
      const c = S.line.charCodeAt(q);
      if (c !== 32 && c !== 9) {
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        return false;
      }
    }
    return true;
  }

  // HTML block start. Returns the end-type (1-7) or 0 when not a block.
  // The cursor is left at the position after the enclosing containers:
  // an HTML block's lines keep their leading spaces (up to 3), so the
  // indent is only scanned locally, never consumed.
  function tryHtmlStart() {
    let p = S.pos;
    let col = S.col;
    let skipped = 0;
    while (skipped < 3 && p < S.line.length) {
      const c = S.line.charCodeAt(p);
      if (c === 32) {
        p++;
        col++;
        skipped++;
      } else if (c === 9) {
        const w = 4 - (col % 4);
        if (skipped + w > 3) break;
        p++;
        col += w;
        skipped += w;
      } else break;
    }
    const rest = S.line.slice(p);
    if (!rest.startsWith('<')) return 0;
    const low = rest.toLowerCase();
    // Type 1: script / pre / style / textarea — OPENING tags only.
    // A closing tag (</pre> etc.) is type 7, which cannot interrupt
    // a paragraph.
    for (const tag of ['script', 'pre', 'style', 'textarea']) {
      if (low.startsWith('<' + tag)) {
        const after = rest[1 + tag.length];
        if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') return 1;
      }
    }
    // Type 2: comment.
    if (rest.startsWith('<!--')) return 2;
    // Type 3: processing instruction.
    if (rest.startsWith('<?')) return 3;
    // Type 4: declaration.
    if (rest.startsWith('<!') && rest.length > 2 && isAlpha(rest.charCodeAt(2))) return 4;
    // Type 5: CDATA.
    if (rest.startsWith('<![CDATA[')) return 5;
    // Type 6: open/close tag with a block tag name.
    {
      const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(rest);
      if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
    }
    // Type 7: a complete open or closing tag, nothing but whitespace after.
    // A closing tag takes no attributes.
    {
      let m;
      if (rest.startsWith('</')) {
        m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(rest);
      } else {
        m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(rest);
      }
      if (m) {
        const after = rest.slice(m[0].length);
        if (/^[ \t]*$/.test(after)) return 7;
      }
    }
    return 0;
  }

  // Thematic break. Returns true when the line is one.
  function isThematicBreak() {
    const savePos = S.pos;
    const saveCol = S.col;
    const saveLine = S.line;
    advanceCols(3);
    let p = S.pos;
    const ch = S.line[p];
    if (ch !== '-' && ch !== '_' && ch !== '*') {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return false;
    }
    let count = 0;
    while (p < S.line.length) {
      const c = S.line.charCodeAt(p);
      if (c === 32 || c === 9) {
        p++;
        continue;
      }
      if (S.line[p] !== ch) {
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        return false;
      }
      count++;
      p++;
    }
    if (count < 3) {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return false;
    }
    return true;
  }

  // Setext heading underline. Returns 1 ('=') or 2 ('-') or 0.
  // Only leading/trailing whitespace is allowed: spaces BETWEEN the
  // underline characters make the line an ordinary paragraph line.
  function setextLevel() {
    let p = S.pos;
    let col = S.col;
    let skipped = 0;
    while (skipped < 3 && p < S.line.length) {
      const c = S.line.charCodeAt(p);
      if (c === 32) {
        p++;
        col++;
        skipped++;
      } else if (c === 9) {
        col += 4 - (col % 4);
        p++;
        skipped++;
      } else break;
    }
    const rest = S.line.slice(p).replace(/[ \t]+$/, '');
    if (rest.length === 0) return 0;
    const ch = rest[0];
    if (ch !== '=' && ch !== '-') return 0;
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] !== ch) return 0;
    }
    return ch === '=' ? 1 : 2;
  }

  // Blockquote start: up to 3 spaces, '>', one optional space/tab.
  // Returns true on a match (cursor advanced past the marker).
  function tryQuoteStart() {
    const savePos = S.pos;
    const saveCol = S.col;
    const saveLine = S.line;
    advanceCols(3);
    if (S.pos < S.line.length && S.line.charCodeAt(S.pos) === 62) {
      S.pos++;
      S.col++;
      if (S.pos < S.line.length) {
        const c = S.line.charCodeAt(S.pos);
        if (c === 32) {
          S.pos++;
          S.col++;
        } else if (c === 9) {
          advanceCols(1);
        }
      }
      return true;
    }
    S.pos = savePos;
    S.col = saveCol;
    S.line = saveLine;
    return false;
  }

  // List item start. Returns the marker info or null.
  // {ordered, start, delim, markerLen, contentCol, relContentCol, empty}
  function tryListStart() {
    const savePos = S.pos;
    const saveCol = S.col;
    const saveLine = S.line;
    // The container-content start on this line: the content indent is
    // measured from here, since container markers differ in width
    // from line to line.
    const baseCol = S.col;
    advanceCols(3);
    const markerCol = S.col;
    let p = S.pos;
    let ordered = false;
    let start = 0;
    let delim = '';
    let markerLen = 0;
    const c = S.line.charCodeAt(p);
    if (c === 45 || c === 43 || c === 42) {
      delim = S.line[p];
      markerLen = 1;
      p++;
    } else if (isDigit(c)) {
      let q = p;
      while (q < S.line.length && isDigit(S.line.charCodeAt(q))) q++;
      if (q - p > 9) {
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        return null;
      }
      if (q >= S.line.length) {
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        return null;
      }
      const d = S.line[q];
      if (d !== '.' && d !== ')') {
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        return null;
      }
      ordered = true;
      start = parseInt(S.line.slice(p, q), 10);
      delim = d;
      markerLen = q - p + 1;
      p = q + 1;
    } else {
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      return null;
    }
    // The marker must be followed by space/tab or end of line.
    if (p < S.line.length) {
      const d = S.line.charCodeAt(p);
      if (d !== 32 && d !== 9) {
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        return null;
      }
    }
    // Content indent: spaces after the marker (1-4 columns). With 5+
    // spaces the content indent is marker + 1. With nothing after the
    // marker the item is empty and the indent is marker + 1.
    let contentCol;
    let empty = false;
    {
      let q = p;
      let col = S.col + (p - S.pos);
      let spaces = 0;
      while (q < S.line.length) {
        const d = S.line.charCodeAt(q);
        if (d === 32) {
          spaces++;
          col++;
          q++;
        } else if (d === 9) {
          const w = 4 - (col % 4);
          spaces += w;
          col += w;
          q++;
        } else break;
      }
      if (q >= S.line.length) {
        empty = true;
        contentCol = markerCol + markerLen + 1;
      } else if (spaces >= 5) {
        contentCol = markerCol + markerLen + 1;
      } else {
        contentCol = markerCol + markerLen + spaces;
      }
    }
    // Success: leave the cursor just past the marker; startList will
    // advance it the rest of the way to the content column.
    S.pos = p;
    S.col = markerCol + markerLen;
    return { ordered, start, delim, markerLen, contentCol, relContentCol: contentCol - baseCol, empty, markerCol };
  }

  // Whether a list item starting here may interrupt a paragraph.
  // The item must not be empty; a bullet list can always interrupt,
  // an ordered list only when it starts with 1 — unless the paragraph
  // sits directly inside a list item, in which case any ordered list
  // may interrupt it.
  function listCanInterrupt(info, inPara) {
    if (!inPara) return true;
    if (info.empty) return false;
    if (!info.ordered) return true;
    if (info.start === 1) return true;
    const par = S.stack.length >= 2 ? S.stack[S.stack.length - 2] : null;
    return par !== null && par.t === 'item';
  }

  // --- The main loop ---
  for (let li = 0; li < lines.length; li++) {
    S.line = lines[li];
    S.pos = 0;
    S.col = 0;
    S.bqMatched = 0;
    S.bqCol = -1;
    S.lineIdx = li;
    // Whether the immediately preceding line was a lazy paragraph
    // continuation (used by the lazy setext-underline rule below).
    const wasLazy = S.prevLazy;
    S.prevLazy = false;
    const blankLine = isBlankStr(S.line);

    // Phase A: match open containers.
    let d = 1;
    let failedAt = -1;
    while (d < S.stack.length) {
      const b = S.stack[d];
      if (b.t !== 'quote' && b.t !== 'list' && b.t !== 'item') break;
      if (!matchContainer(b)) {
        failedAt = d;
        break;
      }
      d++;
    }
    // Lazy continuation: the containers failed to match, but the tip
    // is a paragraph and the line is not blank, so the line continues
    // that paragraph instead of closing the containers. The paragraph
    // logic below runs with `lazy` set: setext underlines do not apply
    // to a lazy line, but tables and block interruptions still do.
    let lazy = false;
    if (failedAt >= 0) {
      // Lazy continuation only when there is actual content after
      // the containers that did match. A line that is empty after
      // them (e.g. a lone '>' inside an outer quote) is blank for
      // the inner containers: it ends them instead of lazily
      // continuing the paragraph (so '> > a', '>', '> > b' splits
      // the inner blockquote in two). A line with only spaces left
      // after a marker is NOT blank — it continues a paragraph.
      if (!blankLine && S.pos < S.line.length && tip().t === 'para') {
        // A line that starts a list item is never a lazy paragraph
        // continuation: the containers close and the list starts.
        const savePos = S.pos;
        const saveCol = S.col;
        const saveLine = S.line;
        const li = tryListStart();
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        if (li) {
          closeTo(failedAt);
        } else {
          lazy = true;
        }
      } else if (!blankLine && tip().t === 'code' && tip().fenced && failedAt >= 0 && S.stack[failedAt].t === 'item') {
        // Marked's list-item rule: a line that fails the item's indent
        // is absorbed into the open fenced code block ONLY when it is
        // not a block start at the item's level and the previous
        // item-text line does not force the item to end. Otherwise the
        // item (and the code block) close and the line is reprocessed
        // outside them — e.g. a fence line at a low indent opens a NEW
        // fenced code block instead of closing this one.
        // (A blockquote container failing still closes everything.)
        const item = S.stack[failedAt];
        const n = Math.max(0, Math.min(3, item.contentCol - 1));
        const cur = S.line.slice(S.pos);
        let hasQuote = false;
        for (let k = failedAt + 1; k < S.stack.length - 1; k++) {
          if (S.stack[k].t === 'quote') { hasQuote = true; break; }
        }
        let startsList = false;
        if (!hasQuote) {
          const savePos = S.pos;
          const saveCol = S.col;
          const saveLine = S.line;
          if (tryListStart()) startsList = true;
          S.pos = savePos;
          S.col = saveCol;
          S.line = saveLine;
        }
        const code = tip();
        const prev = code.prevText || '';
        const endsItem =
          hasQuote || startsList ||
          fenceBeginStr(cur, n) || headingBeginStr(cur, n) || htmlBeginStr(cur, n) ||
          quoteBeginStr(cur, n) || hrBeginStr(cur, n) ||
          !!code.prevBlank ||
          leadWidth4(prev) >= 4 ||
          fenceBeginStr(prev, n) || headingBeginStr(prev, n) || htmlBeginStr(prev, n) || hrBeginStr(prev, n);
        if (endsItem) closeTo(failedAt);
        // Else absorb: fall through; Phase C pushes the line as code
        // content (with the containers matched so far stripped).
      } else {
        closeTo(failedAt);
      }
    }

    const t = tip();

    // A line is blank when the raw line is blank, or when nothing is
    // left after the enclosing container markers (e.g. "> " inside a
    // blockquote). A line with only spaces left after a marker (">  ")
    // is NOT blank: it continues a paragraph with a space line.
    const blank = blankLine || S.pos >= S.line.length;

    // Phase B: blank lines.
    if (blank) {
      // A blank line inside fenced/indented code or a type 1-5 HTML
      // block is content, not a structural blank.
      const isContentBlank = (t.t === 'code') || (t.t === 'html' && t.endType <= 5);
      if (t.t === 'para') {
        S.stack.pop();
        finalize(t);
      } else if (t.t === 'code' && t.fenced) {
        // A blank line inside fenced code keeps its content (spaces);
        // a leading tab becomes spaces only inside a container (see
        // inContainer); at the top level Dt strips characters and a
        // tab stays literal. A backtick fence strips its own indent
        // from content lines; a tilde fence does not.
        if (t.fenceChar === '`') advanceCols(t.fenceIndent, true);
        if (inContainer()) expandLeadingTabs();
        t.lines.push(S.line.slice(S.pos));
        // A blank line is the previous line for the absorption rule:
        // the next under-indented line ends the item, not the code.
        t.prevBlank = true;
        t.prevText = '';
      } else if (t.t === 'code' && !t.fenced) {
        // A blank line inside indented code keeps its content minus
        // the 4-column code indent; a leading tab stays a tab.
        advanceCols(4, true);
        t.lines.push(S.line.slice(S.pos));
      } else if (t.t === 'html' && t.endType <= 5) {
        t.lines.push(S.line.slice(S.pos));
        t.lastLine = S.lineIdx;
      } else if (t.t === 'html') {
        S.stack.pop();
        finalize(t);
      } else if (t.t === 'table') {
        // A line that is blank except for a tab is a table row of
        // empty cells, not a blank line ending the table. (A line
        // with only spaces, or truly empty, does end the table.)
        if (S.line.includes('\t')) {
          const cells = splitTableRow(S.line.slice(S.pos));
          const row = [];
          for (let k = 0; k < t.align.length; k++) row.push(k < cells.length ? cells[k] : '');
          t.rows.push(row);
          S.blankPending = false;
          S.blankPendingStructural = false;
          continue;
        } else {
          S.stack.pop();
          finalize(t);
        }
      }
      // A blank line is a separator for blocks inside an item unless
      // it was consumed as code/HTML content. A line that is blank
      // only past a container marker (e.g. ">>") still separates
      // blocks inside the item, but it does not separate list items
      // (only a truly blank raw line does that).
      if (!isContentBlank) {
        S.blankPending = true;
        if (blankLine) S.blankPendingStructural = true;
      }
      if (blankLine && !isContentBlank) {
        // A blank line marks the innermost open item as ending blank.
        for (let k = S.stack.length - 1; k >= 1; k--) {
          if (S.stack[k].t === 'item') {
            S.stack[k].endsBlank = true;
            break;
          }
        }
        // An empty list item is closed by a blank line: it cannot take
        // content afterwards (a non-empty item stays open).
        if (tip().t === 'item' && tip().children.length === 0) {
          const it = S.stack.pop();
          finalize(it);
        }
      }
      if (!isContentBlank && !blankLine && tip().t === 'item') {
        // A marker-only blank (e.g. '>') that leaves the tip at the
        // list item itself separates this item from the next one, so
        // the item ends blank and the list is loose. When the tip is
        // a nested block (e.g. a blockquote inside the item), the
        // blank only separates blocks inside the item and does not
        // loosen the list.
        tip().endsBlank = true;
      }
      continue;
    }

    // Phase C: the tip is a leaf — does the line continue it?
    if (t.t === 'code' && t.fenced) {
      if (isClosingFence(t)) {
        S.stack.pop();
        finalize(t);
      } else {
        // Record the line as it stands in the item text (before the
        // fence's own indent is stripped): the list-item absorption
        // rule judges the previous line by this text.
        t.prevText = S.line.slice(S.pos);
        t.prevBlank = false;
        // A backtick fence strips its own indent from content lines;
        // a tilde fence does not. A leading tab expands to spaces
        // only inside a container (see inContainer); at the top level
        // Dt strips characters and a tab stays literal.
        if (t.fenceChar === '`') advanceCols(t.fenceIndent, true);
        if (inContainer()) expandLeadingTabs();
        t.lines.push(S.line.slice(S.pos));
      }
      S.blankPending = false;
      S.blankPendingStructural = false;
      continue;
    }
    if (t.t === 'code' && !t.fenced) {
      const ind = indentAt();
      if (ind >= 4) {
        advanceCols(4, true);
        t.lines.push(S.line.slice(S.pos));
        S.blankPending = false;
        S.blankPendingStructural = false;
        continue;
      }
      S.stack.pop();
      finalize(t);
      // Fall through to new-block logic.
    }
    if (t.t === 'html') {
      const line = S.line.slice(S.pos);
      let ends = false;
      if (t.endType === 1) ends = /<\/(script|pre|style|textarea)\s*>/i.test(line);
      else if (t.endType === 2) ends = line.includes('-->');
      else if (t.endType === 3) ends = line.includes('?>');
      else if (t.endType === 4) ends = line.includes('>');
      else if (t.endType === 5) ends = line.includes(']]>');
      t.lines.push(line);
      t.lastLine = S.lineIdx;
      if (ends) {
        t.endedByTerminator = true;
        S.stack.pop();
        finalize(t);
      }
      S.blankPending = false;
      S.blankPendingStructural = false;
      continue;
    }
    if (t.t === 'table') {
      // A table row ends the table when it starts a structural block.
      const savePos = S.pos;
      const saveCol = S.col;
      const saveLine = S.line;
      const heading = tryAtheading();
      const fence = heading ? null : tryFencedStart();
      const htmlType = !heading && !fence ? tryHtmlStart() : 0;
      const thematic = !heading && !fence && !htmlType ? isThematicBreak() : false;
      const quoteStart = !heading && !fence && !htmlType && !thematic ? tryQuoteStart() : false;
      const listInfo = !heading && !fence && !htmlType && !thematic && !quoteStart ? tryListStart() : null;
      const indented = !heading && !fence && !htmlType && !thematic && !quoteStart && !listInfo && indentAt() >= 4;
      S.pos = savePos;
      S.col = saveCol;
      S.line = saveLine;
      if (heading || fence || htmlType || thematic || quoteStart || listInfo || indented) {
        S.stack.pop();
        finalize(t);
        // Fall through to new-block logic.
      } else {
        const cells = splitTableRow(S.line.slice(S.pos));
        const row = [];
        for (let k = 0; k < t.align.length; k++) row.push(k < cells.length ? cells[k] : '');
        t.rows.push(row);
        S.blankPending = false;
        S.blankPendingStructural = false;
        continue;
      }
    }
    if (t.t === 'para') {
      // Setext heading? (A lazy line is never a setext underline.)
      const level = lazy ? 0 : setextLevel();
      if (level > 0) {
        S.stack.pop();
        finalize(t);
        if (t.lines.length > 0) {
          // The paragraph node is replaced by the heading: take it out
          // of its parent's children (finalize only removes it when it
          // became empty through definition extraction).
          const parent = tip();
          const idx = parent.children.indexOf(t);
          if (idx >= 0) parent.children.splice(idx, 1);
          const hlines = t.lines.slice();
          hlines[0] = hlines[0].replace(/^[ \t]+/, '');
          hlines[hlines.length - 1] = hlines[hlines.length - 1].replace(/[ \t]+$/, '');
          addBlock({ t: 'heading', level, lines: hlines });
          S.blankPending = false;
          S.blankPendingStructural = false;
          continue;
        }
        // The paragraph was only link reference definitions: this line
        // starts fresh blocks below.
        startBlocks();
        S.blankPending = false;
        S.blankPendingStructural = false;
        continue;
      }
      // Table? The paragraph must have exactly one line AFTER leading
      // link reference definitions are stripped, plus a delimiter row.
      {
        // Dry run: do not register definitions from a paragraph that
        // is still growing (a later line may invalidate them).
        const probe = extractDefinitions(t.lines.slice(), S.refs, false);
        if (probe.length === 1) {
          const ind = indentAt();
          // A thematic break is never a table delimiter row.
          let aligns = null;
          if (ind <= 3) {
            const savePos = S.pos;
            const saveCol = S.col;
            const saveLine = S.line;
            const thematic = isThematicBreak();
            S.pos = savePos;
            S.col = saveCol;
            S.line = saveLine;
            if (!thematic) aligns = parseDelimiterRow(S.line.slice(S.pos));
          }
          // The delimiter row must have exactly as many cells as the
          // header row, or this is not a table. A line that starts a
          // list item is a list, not a delimiter row.
          const headerCells = splitTableRow(probe[0]);
          let listStart = null;
          if (ind <= 3) {
            const savePos2 = S.pos;
            const saveCol2 = S.col;
            const saveLine2 = S.line;
            listStart = tryListStart();
            S.pos = savePos2;
            S.col = saveCol2;
            S.line = saveLine2;
          }
          if (aligns && !listStart && aligns.length === headerCells.length) {
            const header = [];
            for (let k = 0; k < aligns.length; k++) header.push(k < headerCells.length ? headerCells[k] : '');
            S.stack.pop();
            // Register the definitions the probe stripped.
            extractDefinitions(t.lines.slice(), S.refs, true);
            t.lines = probe;
            finalize(t);
            if (t.lines.length > 0) {
              const parent = tip();
              const idx = parent.children.indexOf(t);
              if (idx >= 0) parent.children.splice(idx, 1);
              const table = { t: 'table', align: aligns, header, rows: [] };
              addBlock(table);
              S.stack.push(table);
              S.blankPending = false;
              S.blankPendingStructural = false;
              continue;
            }
            // The paragraph was only link reference definitions: the
            // delimiter row line is handled as a new block below.
            startBlocks();
            S.blankPending = false;
            S.blankPendingStructural = false;
            continue;
          }
        }
      }
      // A new block that can interrupt the paragraph?
      {
        const savePos = S.pos;
        const saveCol = S.col;
        const saveLine = S.line;
        const heading = tryAtheading();
        const fence = heading ? null : tryFencedStart();
        const htmlType = !heading && !fence ? tryHtmlStart() : 0;
        const thematic = !heading && !fence && !htmlType ? isThematicBreak() : false;
        const quoteStart = !heading && !fence && !htmlType && !thematic ? tryQuoteStart() : false;
        const listInfo = !heading && !fence && !htmlType && !thematic && !quoteStart ? tryListStart() : null;
        // A list item that continues an already-open list (same type
        // and delimiter) interrupts a paragraph inside that list even
        // when it would not interrupt a paragraph on its own (an
        // ordered item not starting with 1, or an empty item).
        let listInterrupts = false;
        if (listInfo) {
          if (listCanInterrupt(listInfo, true)) listInterrupts = true;
          else {
            for (let k = S.stack.length - 1; k >= 1; k--) {
              if (S.stack[k].t === 'list') {
                if (S.stack[k].ordered === listInfo.ordered && S.stack[k].delim === listInfo.delim) listInterrupts = true;
                break;
              }
            }
          }
        }
        const interrupts = heading || fence || (htmlType >= 1 && htmlType <= 6) || thematic || quoteStart ||
          listInterrupts;
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        if (interrupts) {
          if (lazy) {
            // The failed containers close as well as the paragraph.
            closeTo(failedAt);
          } else {
            S.stack.pop();
            finalize(t);
          }
          // Fall through to new-block logic.
        } else {
          // Continue the paragraph. A line indented by 4+ columns
          // past the item's content indent (in a list item) or past
          // the container markers (a lazy line) loses 4 columns.
          const inner = tipContainerItem();
          if ((inner || lazy) && indentAt() >= 4) advanceCols(4);
          // A leading tab in a paragraph line inside a container
          // (e.g. blockquote) expands to spaces; at the top level
          // (S.pos 0) it stays a literal tab.
          expandLeadingTabs();
          let text = S.line.slice(S.pos);
          if (lazy) {
            // A lazy line that looks like a setext '=' underline, in a
            // paragraph directly inside a blockquote, following another
            // lazy line, is indented by 4 spaces so it stays paragraph
            // text instead of becoming a heading.
            const parent = S.stack[S.stack.length - 2];
            if (wasLazy && parent && parent.t === 'quote') {
              const trimmed = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
              if (trimmed.length > 0 && /^=+$/.test(trimmed)) {
                text = '    ' + text.replace(/^[ \t]+/, '');
              }
            }
            S.prevLazy = true;
          }
          t.lines.push(text);
          S.blankPending = false;
          S.blankPendingStructural = false;
          continue;
        }
      }
    }

    // Phase D: start new blocks at the cursor.
    startBlocks();
    S.blankPending = false;
    S.blankPendingStructural = false;
  }

  // Innermost open list item (or null).
  function tipContainerItem() {
    for (let k = S.stack.length - 1; k >= 1; k--) {
      if (S.stack[k].t === 'item') return S.stack[k];
      if (S.stack[k].t === 'para' || S.stack[k].t === 'code' || S.stack[k].t === 'html' || S.stack[k].t === 'table') continue;
      return null;
    }
    return null;
  }

  // Try to start new blocks at the cursor; anything left becomes a paragraph.
  function startBlocks() {
    for (;;) {
      // Nothing to start on a line that is blank past the containers.
      if (isBlankFromHere()) return;
      // A trailing open list ends when a non-list block starts at its
      // level. A list item of the same type continues the list instead.
      if (tip().t === 'list') {
        const savePos = S.pos;
        const saveCol = S.col;
        const saveLine = S.line;
        // A thematic break is checked before a list start: '* * *'
        // and '- - -' are breaks, not list items.
        const thematic = isThematicBreak();
        const li = thematic ? null : tryListStart();
        if (li && tip().ordered === li.ordered && tip().delim === li.delim) {
          startList(li);
          return;
        }
        S.pos = savePos;
        S.col = saveCol;
        S.line = saveLine;
        S.stack.pop();
      }
      const heading = tryAtheading();
      if (heading) {
        addBlock(heading);
        return;
      }
      const fenceLine = S.line.slice(S.pos);
      const fence = tryFencedStart();
      if (fence) {
        const code = { t: 'code', fenced: true, fenceChar: fence.fenceChar, fenceLen: fence.fenceLen, fenceIndent: fence.fenceIndent, info: fence.info, lines: [], prevText: fenceLine, prevBlank: false };
        addBlock(code);
        S.stack.push(code);
        return;
      }
      const htmlType = tryHtmlStart();
      if (htmlType) {
        const firstLine = S.line.slice(S.pos);
        const html = { t: 'html', lines: [firstLine], endType: htmlType, lastLine: S.lineIdx };
        // Type 1-5 blocks end only at their terminator; 6-7 at a blank line.
        // The first line may already contain the terminator.
        addBlock(html);
        S.stack.push(html);
        let ends = false;
        if (htmlType === 1) ends = /<\/(script|pre|style|textarea)\s*>/i.test(firstLine);
        else if (htmlType === 2) ends = firstLine.includes('-->');
        else if (htmlType === 3) ends = firstLine.includes('?>');
        else if (htmlType === 4) ends = firstLine.includes('>');
        else if (htmlType === 5) ends = firstLine.includes(']]>');
        if (ends) {
          html.endedByTerminator = true;
          S.stack.pop();
          finalize(html);
        }
        return;
      }
      if (isThematicBreak()) {
        addBlock({ t: 'hr' });
        return;
      }
      if (tryQuoteStart()) {
        const quote = { t: 'quote', children: [] };
        addBlock(quote);
        S.stack.push(quote);
        // The rest of the line starts blocks inside the quote; when
        // nothing follows the marker, the quote stays empty for now.
        if (!isBlankFromHere()) startBlocks();
        return;
      }
      const listInfo = tryListStart();
      if (listInfo) {
        startList(listInfo);
        return;
      }
      // Indented code (only when not in a paragraph — we are not).
      if (indentAt() >= 4) {
        advanceCols(4);
        const code = { t: 'code', fenced: false, fenceChar: '', fenceLen: 0, info: '', lines: [S.line.slice(S.pos)] };
        addBlock(code);
        S.stack.push(code);
        return;
      }
      // Otherwise a paragraph.
      expandLeadingTabs();
      const para = { t: 'para', lines: [S.line.slice(S.pos)] };
      addBlock(para);
      S.stack.push(para);
      return;
    }
  }

  // Start (or continue) a list at the cursor, given the marker info.
  function startList(info) {
    let list = null;
    const t = tip();
    if (t.t === 'list' && t.ordered === info.ordered && t.delim === info.delim) {
      list = t;
      // A new item after a blank-ended previous item, or after a
      // truly blank line, makes the list loose.
      const prev = list.children[list.children.length - 1];
      if (prev && prev.endsBlank) list.loose = true;
      if (S.blankPendingStructural) list.loose = true;
    } else {
      list = { t: 'list', ordered: info.ordered, start: info.start, delim: info.delim, tight: true, loose: false, children: [] };
      addBlock(list);
      S.stack.push(list);
    }
    const item = { t: 'item', children: [], contentCol: info.relContentCol, endsBlank: false };
    list.children.push(item);
    S.stack.push(item);
    // Position the cursor at the item's content.
    advanceCols(info.contentCol - S.col);
    if (info.empty) {
      // An empty item has no content; leave the cursor where it is.
      return;
    }
    // The item's content starts a block (usually a paragraph) on this line.
    startBlocks();
  }

  // Close everything left open.
  closeTo(1);
  // A trailing blank line does not make a list loose; the loose flag was
  // only set by the checks above. Derive tight from loose.
  markTight(root);
  return root;
}

function markTight(node) {
  if (!node.children) return;
  for (const ch of node.children) {
    if (ch.t === 'list') ch.tight = !ch.loose;
    markTight(ch);
  }
}

// ---------------------------------------------------------------------------
// The block renderer
// ---------------------------------------------------------------------------

function renderBlocks(node, refs, out) {
  for (const ch of node.children) renderBlock(ch, refs, out);
}

function renderBlock(b, refs, out) {
  switch (b.t) {
    case 'heading': {
      out.push('<h' + b.level + '>' + parseInlineToHtml(b.lines.join('\n'), refs) + '</h' + b.level + '>\n');
      break;
    }
    case 'para': {
      out.push('<p>' + renderParaInline(b, refs) + '</p>\n');
      break;
    }
    case 'code': {
      // Trailing blank lines were already stripped in finalize
      // (fenced: exactly one; indented: all).
      const lines = b.lines;
      let html = '<pre><code';
      if (b.fenced && b.info) {
        // First word of the info string, then unescape it.
        const lang = unescapeStr(b.info.split(/[ \t]+/)[0]);
        if (lang) html += ' class="language-' + escAttr(lang) + '"';
      }
      html += '>' + escAll(lines.join('\n'));
      if (lines.length) html += '\n';
      html += '</code></pre>\n';
      out.push(html);
      break;
    }
    case 'hr': {
      out.push('<hr>\n');
      break;
    }
    case 'html': {
      // Lines joined with newlines; a trailing newline only when the
      // block's last line is the input's last line and the input ends
      // with a newline (see finalize).
      for (let k = 0; k < b.lines.length; k++) {
        out.push(b.lines[k]);
        if (k < b.lines.length - 1 || b.trailingNl) out.push('\n');
      }
      break;
    }
    case 'quote': {
      out.push('<blockquote>\n');
      renderBlocks(b, refs, out);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      let open = '<' + tag;
      if (b.ordered && b.start !== 1) open += ' start="' + b.start + '"';
      open += '>\n';
      out.push(open);
      for (const item of b.children) renderItem(item, b.tight, refs, out);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < b.align.length; i++) {
        const a = b.align[i];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInlineToHtml(b.header[i] || '', refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let i = 0; i < b.align.length; i++) {
            const a = b.align[i];
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInlineToHtml(row[i] || '', refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

// Render a paragraph's inline content, handling a task-list checkbox
// at the start of a list item's paragraph.
function renderParaInline(b, refs) {
  let text = b.lines.join('\n');
  let prefix = '';
  if (b.taskChecked !== undefined) {
    prefix = b.taskChecked
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ';
  }
  return prefix + parseInlineToHtml(text, refs);
}

function renderItem(item, tight, refs, out) {
  const ch = item.children;
  // A list item never puts a newline after <li>: a tight item's
  // paragraph renders bare, a loose item's paragraphs keep <p> tags,
  // and every child block already ends with its own newline.
  out.push('<li>');
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    if (c.t === 'para') {
      // Task-list checkbox: only the first paragraph of an item.
      if (i === 0) detectTask(c);
      if (tight) out.push(renderParaInline(c, refs));
      else renderBlock(c, refs, out);
    } else {
      renderBlock(c, refs, out);
    }
  }
  out.push('</li>\n');
}

// If the paragraph starts with "[ ] " / "[x] " / "[X] ", mark it as a
// task-list item (the checkbox replaces the marker when rendering).
function detectTask(para) {
  const first = para.lines[0];
  if (!first) return;
  const m = /^\[([ xX])\] /.exec(first);
  if (!m) return;
  para.taskChecked = m[1] !== ' ';
  para.lines[0] = first.slice(4);
  if (para.lines[0] === '' && para.lines.length > 1) {
    // "[ ] " alone on the first line: the marker line disappears and
    // the rest of the paragraph follows.
    para.lines.shift();
  }
}

// ---------------------------------------------------------------------------
// Entry point — see the top of the file (export function parse).
// ---------------------------------------------------------------------------

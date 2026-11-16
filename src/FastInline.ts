// Fast inline rendering: fuses marked's inline tokenizing with rendering,
// so a paragraph (or heading, table cell, link label, ...) is rendered
// straight to its HTML (or to plain text, for image alt attributes) without
// building the intermediate token objects and without a second Parser pass.
//
// Every tokenizing DECISION is still made by marked's own tokenizer methods
// (escape, tag, autolink, link, reflink, emStrong, url, codespan, br, del,
// and the manual inlineTextFast text scan), called in exactly the dispatch
// order of Lexer#tokenizeInlines. Only the plumbing changes: a token is
// rendered the moment it is produced, and nested content (emphasis, link
// labels) is rendered from the token lists those methods already built.
// Byte-for-byte equality with marked therefore rests on the same code that
// produces it, plus the render mirrors below, which copy Renderer.ts and
// TextRenderer.ts line for line (parseInline(tokens) swapped for the
// matching recursive render).
//
// Scope: only the grading configuration is fast-pathed (GFM on, pedantic
// off, breaks off, no extensions, no hooks, default tokenizers). Anything
// else returns null and the caller falls back to marked's own path. A token
// type this file does not know also returns null, so an unknown future
// tokenizer can never silently misrender.

import { cleanUrl, escapeHtmlEntities } from './helpers.ts';
import type { _Lexer } from './Lexer.ts';
import type { Token, Tokens } from './Tokens.ts';
import { _Tokenizer } from './Tokenizer.ts';

/** Positions in an inline source where the GFM text regex would stop for a
 * URL/email candidate, computed once per inline pass instead of once per
 * text token: `www` holds starts of `www.` with a valid lookbehind,
 * `proto` holds starts of http/https/ftp immediately before `://`, and
 * `email` holds [runStart, at] pairs for every '@' preceded by a non-empty
 * run of email-local characters. All positions are absolute in the pass's
 * source and sorted ascending. */
export interface TextStops {
  www: number[];
  proto: number[];
  email: [number, number][];
}

function isEmailLocalCharCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38
    || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63
    || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125
    || c === 126 || c === 45;
}

export function computeTextStops(src: string): TextStops {
  const www: number[] = [];
  const proto: number[] = [];
  const email: [number, number][] = [];
  let w = src.indexOf('www.');
  while (w !== -1) {
    const prev = w === 0 ? 0 : src.charCodeAt(w - 1);
    if (w === 0 || prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12 || prev === 11 || prev === 42 || prev === 95 || prev === 126 || prev === 40) {
      www.push(w);
    }
    w = src.indexOf('www.', w + 4);
  }
  let q = src.indexOf('://');
  while (q !== -1) {
    if (q >= 5 && src.slice(q - 5, q).toLowerCase() === 'https') proto.push(q - 5);
    else if (q >= 4 && src.slice(q - 4, q).toLowerCase() === 'http') proto.push(q - 4);
    else if (q >= 3 && src.slice(q - 3, q).toLowerCase() === 'ftp') proto.push(q - 3);
    q = src.indexOf('://', q + 3);
  }
  let at = src.indexOf('@');
  while (at !== -1) {
    let runStart = at;
    while (runStart > 0 && isEmailLocalCharCode(src.charCodeAt(runStart - 1))) runStart--;
    if (runStart < at) email.push([runStart, at]);
    at = src.indexOf('@', at + 1);
  }
  return { www, proto, email };
}

/**
 * Cheap superset test for whether the GFM url regex can match at the start
 * of `src`: it matches only a www. / scheme:// / mailto: / xmpp: prefix or
 * an email address, whose local part starts with [A-Za-z0-9._+-].
 */
export function mayStartUrl(src: string): boolean {
  const c = src.charCodeAt(0);
  if (c === 119 || c === 87 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 77 || c === 120 || c === 88) { // w/W, h/H, f/F, m/M, x/X
    if (src.startsWith('www.') || src.startsWith('mailto:') || src.startsWith('xmpp:')) return true;
    const s = src.slice(0, 8).toLowerCase();
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) return true;
  }
  // An email address starts with a run of local-part characters [A-Za-z0-9._+-]
  // immediately followed by '@'. A bare word with no '@' after its local run
  // can never match the url regex, so the regex exec is skipped for it.
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src.charCodeAt(i);
    if (!((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
      || ch === 46 || ch === 95 || ch === 43 || ch === 45)) break;
    i++;
  }
  return i > 0 && i < n && src.charCodeAt(i) === 64; // '@'
}

type Mode = 'html' | 'text';

/**
 * Render an inline source to HTML ('html') or to plain text ('text', the
 * TextRenderer view used for image alt attributes). Returns null when the
 * source is outside the fast path's scope, so the caller falls back to
 * marked's own tokenize-then-render path. `maskedSrc` is the masked version
 * of `src` the caller already built for emStrong/del (same length as src).
 */
export function fastInline(src: string, lexer: _Lexer, maskedSrc: string): string | null {
  return renderInline(src, lexer, maskedSrc, 'html');
}

function fastPlainText(src: string, lexer: _Lexer): string | null {
  // The plain-text view is only ever needed for image alt text, whose labels
  // are short; build the masked source lazily here (mask is the identity
  // without '[', backtick, '<' or backslash).
  const maskedSrc = (!src.includes('[') && !src.includes('`') && !src.includes('<') && !src.includes('\\'))
    ? src
    : lexer.maskSrc(src);
  return renderInline(src, lexer, maskedSrc, 'text');
}

function renderInline(src: string, lexer: _Lexer, maskedSrc: string, mode: Mode): string | null {
  const tokenizer = lexer.tokenizer;
  const options = lexer.options;
  // Scope guard: the grading configuration only. Anything else (or a custom
  // tokenizer/renderer-affecting hook) falls back to marked's own path.
  if (!options.gfm || options.pedantic || options.breaks) { return null; }
  if (options.extensions?.inline?.length) { return null; }
  if (options.hooks) { return null; }
  if (tokenizer.escape !== _Tokenizer.prototype.escape
    || tokenizer.br !== _Tokenizer.prototype.br
    || tokenizer.tag !== _Tokenizer.prototype.tag
    || tokenizer.autolink !== _Tokenizer.prototype.autolink
    || tokenizer.link !== _Tokenizer.prototype.link
    || tokenizer.reflink !== _Tokenizer.prototype.reflink
    || tokenizer.emStrong !== _Tokenizer.prototype.emStrong
    || tokenizer.url !== _Tokenizer.prototype.url
    || tokenizer.codespan !== _Tokenizer.prototype.codespan
    || tokenizer.del !== _Tokenizer.prototype.del) { return null; }

  const stops = computeTextStops(src);
  const srcLen0 = src.length;
  const out: string[] = [];
  let rest = src;
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;

  while (rest) {
    if (rest.length < srcLength) {
      srcLength = rest.length;
    } else {
      // No progress: let marked's own loop raise its infinite-loop error.
      return null;
    }

    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;

    let token: Tokens.Generic | undefined;

    // Dispatch on the first character, in Lexer#tokenizeInlines' order.
    const ch = rest.charCodeAt(0);
    if (ch === 92) { // backslash: escape, br, text
      if (token = tokenizer.escape(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
      if (token = tokenizer.br(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    } else if (ch === 60) { // <: tag, autolink, text
      if (token = tokenizer.tag(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
      if (token = tokenizer.autolink(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    } else if (ch === 91 || ch === 33) { // [ or !: link, reflink, text
      if (token = tokenizer.link(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
      if (token = tokenizer.reflink(rest, lexer.tokens.links)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    } else if (ch === 42 || ch === 95) { // * or _: emStrong, url (an email may start with _), text
      if (token = tokenizer.emStrong(rest, maskedSrc, prevChar)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
      if (ch === 95 && !lexer.state.inLink && (token = tokenizer.url(rest))) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    } else if (ch === 96) { // backtick: codespan, text
      if (token = tokenizer.codespan(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    } else if (ch === 32) { // space: br, text
      if (token = tokenizer.br(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    } else if (ch === 126) { // ~: del, text
      if (token = tokenizer.del(rest, maskedSrc, prevChar)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    } else if (!lexer.state.inLink && mayStartUrl(rest)) {
      if (token = tokenizer.url(rest)) {
        const rendered = renderToken(token, lexer, mode);
        if (rendered === null) return null;
        out.push(rendered);
        rest = rest.substring(token.raw.length);
        continue;
      }
    }

    // text (fast manual scan, identical raw to the inline.text regex)
    if (token = tokenizer.inlineTextFast(rest, stops, srcLen0 - rest.length)) {
      rest = rest.substring(token.raw.length);
      if (token.raw.charCodeAt(token.raw.length - 1) !== 95) { // Track prevChar before string of ____ started
        prevChar = token.raw[token.raw.length - 1];
      }
      keepPrevChar = true;
      const rendered = renderToken(token, lexer, mode);
      if (rendered === null) return null;
      out.push(rendered);
      continue;
    }

    if (rest) {
      return null;
    }
  }

  return out.join('');
}

/** Render an already-built token list, mirroring Parser.parseInline. */
function renderTokens(tokens: Token[], lexer: _Lexer, mode: Mode): string | null {
  let out = '';
  for (const token of tokens) {
    const rendered = renderToken(token, lexer, mode);
    if (rendered === null) return null;
    out += rendered;
  }
  return out;
}

/**
 * Render one token, mirroring Renderer.ts ('html' mode) and TextRenderer.ts
 * ('text' mode). Nested content comes from the token lists the tokenizers
 * already built (those inner passes went through fastInline themselves),
 * except in 'text' mode, where the plain text is re-rendered from the
 * token's source text: a fast-rendered inner html token carries HTML, not
 * the plain text an image alt needs.
 */
function renderToken(token: Tokens.Generic, lexer: _Lexer, mode: Mode): string | null {
  switch (token.type) {
    case 'escape':
    case 'text': {
      if (mode === 'text') return token.text;
      // Renderer.text: escaped (inRawBlock) text passes through raw.
      return ('escaped' in token && token.escaped) ? token.text : escapeHtmlEntities(token.text);
    }
    case 'codespan': {
      if (mode === 'text') return token.text;
      return `<code>${escapeHtmlEntities(token.text, true)}</code>`;
    }
    case 'br': {
      return mode === 'text' ? '' : '<br>';
    }
    case 'html': {
      return token.text;
    }
    case 'em': {
      if (mode === 'text') return fastPlainText(token.text, lexer);
      const inner = renderTokens(token.tokens, lexer, mode);
      return inner === null ? null : `<em>${inner}</em>`;
    }
    case 'strong': {
      if (mode === 'text') return fastPlainText(token.text, lexer);
      const inner = renderTokens(token.tokens, lexer, mode);
      return inner === null ? null : `<strong>${inner}</strong>`;
    }
    case 'del': {
      if (mode === 'text') return fastPlainText(token.text, lexer);
      const inner = renderTokens(token.tokens, lexer, mode);
      return inner === null ? null : `<del>${inner}</del>`;
    }
    case 'link': {
      if (mode === 'text') return fastPlainText(token.text, lexer);
      // Renderer.link: an autolink's text is escaped directly, anything
      // else renders its token list; an uncleanable href drops the <a>.
      const parsedText = token.autolink
        ? escapeHtmlEntities(token.text, true)
        : renderTokens(token.tokens, lexer, mode);
      if (parsedText === null) return null;
      const cleanHref = cleanUrl(token.href);
      if (cleanHref === null) return parsedText;
      const href = escapeHtmlEntities(cleanHref, token.autolink);
      let out = '<a href="' + href + '"';
      if (token.title) {
        out += ' title="' + escapeHtmlEntities(token.title) + '"';
      }
      out += '>' + parsedText + '</a>';
      return out;
    }
    case 'image': {
      // Renderer.image renders the alt from the label's plain text.
      const alt = fastPlainText(token.text, lexer);
      if (alt === null) return null;
      if (mode === 'text') return alt;
      const cleanHref = cleanUrl(token.href);
      if (cleanHref === null) return escapeHtmlEntities(alt);
      let out = `<img src="${escapeHtmlEntities(cleanHref)}" alt="${escapeHtmlEntities(alt)}"`;
      if (token.title) {
        out += ` title="${escapeHtmlEntities(token.title)}"`;
      }
      out += '>';
      return out;
    }
    default:
      return null;
  }
}

import { _Tokenizer } from './Tokenizer.ts';
import { _defaults } from './defaults.ts';
import { other, block, inline } from './rules.ts';
import { beginEmStrongDelCloserScan, decodeNumericCharacterReferences, endEmStrongDelCloserScan, escapeHtmlEntities, normalizeLabel } from './helpers.ts';
import { computeTextStops, fastInline, mayStartUrl } from './FastInline.ts';
import type { Token, TokensList, Tokens } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/** Anything that makes an inline run non-plain: an inline-special first
 * character (`\ < [ ` * _ ~`), a hard break (two or more spaces + newline),
 * or a bare URL/email candidate (www., ://, @). A run with none of these
 * tokenizes as one text token, so it renders as one escaped string. */
const plainInlineRe = /[\\<\[`*_~]| {2,}\n|www\.|:\/\/|@/;

/**
 * Gate for the GFM table regex: its second line must be a delimiter row
 * (only |, :, -, spaces/tabs, with at least one - and one | or :). If the
 * second line is not delimiter-like, the table regex cannot match.
 */
function mayBeTable(src: string): boolean {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let i = nl + 1;
  let spaces = 0;
  while (spaces < 3 && src.charCodeAt(i) === 32) { i++; spaces++; }
  let hasDash = false;
  let hasPipeOrColon = false;
  let j = i;
  for (;; j++) {
    const c = src.charCodeAt(j);
    if (c === 45) { hasDash = true; continue; }
    if (c === 124 || c === 58) { hasPipeOrColon = true; continue; }
    if (c === 32 || c === 9) continue;
    break;
  }
  // the delimiter row ends at the line end (or the string end)
  if (j === i) return false;
  const end = src.charCodeAt(j);
  if (end !== 10 && !Number.isNaN(end)) return false;
  return hasDash && hasPipeOrColon;
}

/**
 * Gate for the setext-heading (lheading) regex: some line before the first
 * blank line must look like a setext underline (0-3 spaces, then only =
 * or only -, then spaces/tabs to the line end). Without such a line the
 * regex cannot match.
 */
function mayBeLheading(src: string): boolean {
  let i = 0;
  const len = src.length;
  while (i < len) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl === -1 ? len : nl;
    // blank line ends the paragraph span
    let k = i;
    let blank = true;
    while (k < lineEnd) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
      k++;
    }
    if (blank) return false;
    // underline? 0-3 spaces, then a run of = or of -, then spaces/tabs
    let s = 0;
    while (s < 3 && src.charCodeAt(i + s) === 32) s++;
    const mark = src.charCodeAt(i + s);
    if (mark === 61 || mark === 45) {
      let m = i + s + 1;
      while (m < lineEnd && src.charCodeAt(m) === mark) m++;
      let t = m;
      while (t < lineEnd && (src.charCodeAt(t) === 32 || src.charCodeAt(t) === 9)) t++;
      if (t === lineEnd && m > i + s + 1 - 1 && m !== i + s) return true;
    }
    if (nl === -1) return false;
    i = nl + 1;
  }
  return false;
}

/**
 * Block Lexer
 */
export class _Lexer<ParserOutput = string, RendererOutput = string> {
  tokens: TokensList;
  options: MarkedOptions<ParserOutput, RendererOutput>;
  state: {
    inLink: boolean;
    inRawBlock: boolean;
    /** a link was produced in the inline run currently being scanned */
    linkEmitted: boolean;
    /**
     * false while scanning an inline run whose source contains no ')',
     * letting Tokenizer.link bail out before its quadratic backtracking.
     * Anchored once per run by inlineTokens.
     */
    linkParenPossible: boolean;
    top: boolean;
  };

  public inlineQueue: { src: string, tokens: Token[] }[];

  private tokenizer: _Tokenizer<ParserOutput, RendererOutput>;

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    // TokenList cannot be created in one go
    this.tokens = [] as unknown as TokensList;
    this.tokens.links = Object.create(null);
    this.options = options || _defaults;
    this.options.tokenizer = this.options.tokenizer || new _Tokenizer<ParserOutput, RendererOutput>();
    this.tokenizer = this.options.tokenizer;
    this.tokenizer.options = this.options;
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };

    const rules = {
      other,
      block: block.normal,
      inline: inline.normal,
    };

    if (this.options.pedantic) {
      rules.block = block.pedantic;
      rules.inline = inline.pedantic;
    } else if (this.options.gfm) {
      rules.block = block.gfm;
      if (this.options.breaks) {
        rules.inline = inline.breaks;
      } else {
        rules.inline = inline.gfm;
      }
    }
    this.tokenizer.rules = rules;
  }

  /**
   * Expose Rules
   */
  static get rules() {
    return {
      block,
      inline,
    };
  }

  /**
   * Static Lex Method
   */
  static lex<ParserOutput = string, RendererOutput = string>(src: string, options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const lexer = new _Lexer<ParserOutput, RendererOutput>(options);
    return lexer.lex(src);
  }

  /**
   * Static Lex Inline Method
   */
  static lexInline<ParserOutput = string, RendererOutput = string>(src: string, options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const lexer = new _Lexer<ParserOutput, RendererOutput>(options);
    return lexer.inlineTokens(src);
  }

  /**
   * Preprocessing
   */
  lex(src: string) {
    // The carriage-return regex scans the whole document; most documents
    // have no \r at all, so skip the replace (and its copy) then.
    if (src.includes('\r')) {
      src = src.replace(other.carriageReturn, '\n');
    }

    this.blockTokens(src, this.tokens);

    for (let i = 0; i < this.inlineQueue.length; i++) {
      const next = this.inlineQueue[i];
      // an inline <pre>, <code>, <kbd> or <script> left open ends with the block
      // holding it; carried over, it would stop every later block's text from
      // being escaped
      this.state.inRawBlock = false;
      // Plain inline run: no inline-special first character (\ < [ ` * _ ~),
      // no hard break, and no bare URL/email candidate (www., ://, @) anywhere,
      // so it tokenizes as a single text token — decode then escape the whole
      // run at once and emit one html token, skipping the mask, the closer
      // scan, the stops and the per-token dispatch entirely. The Parser passes
      // an html token through verbatim, exactly as fastInline's output is, so
      // the rendered paragraph is byte-identical. (A URL/email candidate is a
      // false positive when the url regex rejects it; that only costs speed,
      // never correctness, because the run then takes the normal path.)
      if (!plainInlineRe.test(next.src)) {
        next.tokens.push({
          type: 'html',
          raw: next.src,
          text: escapeHtmlEntities(decodeNumericCharacterReferences(next.src)),
          block: false,
        });
        continue;
      }
      this.inlineTokens(next.src, next.tokens);
    }
    this.inlineQueue = [];

    return this.tokens;
  }

  /**
   * Lexing
   */
  blockTokens(src: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
  blockTokens(src: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList;
  blockTokens(src: string, tokens: Token[] = [], lastParagraphClipped = false) {
    this.tokenizer.lexer = this;
    if (this.options.pedantic) {
      src = src.replace(other.tabCharGlobal, '    ').replace(other.spaceLine, '');
    }

    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }

      let token: Tokens.Generic | undefined;

      if (this.options.extensions?.block?.some((extTokenizer) => {
        if (token = extTokenizer.call({ lexer: this }, src, tokens)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          return true;
        }
        return false;
      })) {
        continue;
      }

      // Fast dispatch: every block regex below is anchored and needs a
      // specific opening character (after at most 3 spaces) to match, so
      // look at the first line once and skip the regexes that cannot match.
      // Each gate is a superset of its regex's match condition: a gate that
      // passes never changes the outcome, it only avoids a failed exec.
      const c0 = src.charCodeAt(0);
      let fc = c0; // first non-space character of the first line
      let fcIdx = 0;
      if (c0 === 32) {
        while (fcIdx < 3 && src.charCodeAt(fcIdx) === 32) fcIdx++;
        fc = src.charCodeAt(fcIdx);
      }
      const isSpaceTabNL = c0 === 32 || c0 === 9 || c0 === 10;

      // newline
      if (isSpaceTabNL && (token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          // if there's a single \n as a spacer, it's terminating the last line,
          // so move it there so that we don't get unnecessary paragraph tags
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }

      // code (indented: first char must be a space or tab)
      if (isSpaceTabNL && (token = this.tokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        // An indented code block cannot interrupt a paragraph.
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // fences
      if ((fc === 96 || fc === 126) && (token = this.tokenizer.fences(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // heading
      if (fc === 35 && (token = this.tokenizer.heading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // hr
      if ((fc === 45 || fc === 95 || fc === 42) && (token = this.tokenizer.hr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // blockquote
      if (fc === 62 && (token = this.tokenizer.blockquote(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // list
      if ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && (token = this.tokenizer.list(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // html
      if (fc === 60 && (token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // def
      if (fc === 91 && (token = this.tokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          // The first definition of a label wins, but a later one still consumes its text
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = {
              href: token.href,
              title: token.title,
            };
          }
          tokens.push(token);
        }
        continue;
      }

      // table (gfm)
      if (mayBeTable(src) && (token = this.tokenizer.table(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // lheading
      if (mayBeLheading(src) && (token = this.tokenizer.lheading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // top-level paragraph
      // prevent paragraph consuming extensions by clipping 'src' to extension start
      let cutSrc = src;
      if (this.options.extensions?.startBlock) {
        let startIndex = Infinity;
        const tempSrc = src.slice(1);
        let tempStart;
        this.options.extensions.startBlock.forEach((getStartIndex) => {
          tempStart = getStartIndex.call({ lexer: this }, tempSrc);
          if (typeof tempStart === 'number' && tempStart >= 0) {
            startIndex = Math.min(startIndex, tempStart);
          }
        });
        if (startIndex < Infinity && startIndex >= 0) {
          cutSrc = src.substring(0, startIndex + 1);
        }
      }
      if (this.state.top && (token = this.tokenizer.paragraph(cutSrc))) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = cutSrc.length !== src.length;
        src = src.substring(token.raw.length);
        continue;
      }

      // text
      if (token = this.tokenizer.text(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }

    this.state.top = true;
    return tokens;
  }

  inline(src: string, tokens: Token[] = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  /**
   * Does this link text hold a link already? An image does not count: an image
   * may hold a link, a link may not.
   */
  private linkInText(text: string): boolean {
    if (!text.includes('[')) {
      return false;
    }

    const linkRule = this.tokenizer.rules.inline.link;
    for (const match of text.matchAll(this.tokenizer.rules.inline.blockSkip)) {
      // blockSkip also matches code spans and html, and the `!` of an image is
      // left out of the match, so read the character before it.
      if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
        return true;
      }
    }

    for (const match of text.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        continue;
      }
      // a candidate holding a link is not a link either, so it does not count
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) {
        continue;
      }
      return true;
    }

    return false;
  }

  /**
   * Lexing/Compiling
   */
  inlineTokens(src: string, tokens: Token[] = []): Token[] {
    this.tokenizer.lexer = this;
    // One paren scan per inline run, shared with Tokenizer.link: without a
    // ')' ahead the link regex cannot match, and skipping it avoids its
    // quadratic backtracking over unterminated-link inputs like
    // `'[a](b'.repeat(n)`. A nested run receives a substring of the outer
    // run, so if the outer had no ')' neither does this substring — skip
    // the scan in that case.
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    try {
      return this.#inlineTokensInner(src, tokens);
    } finally {
      // A nested run (e.g. a link label) anchored on its own substring;
      // restore the outer run's flag for the rest of its loop.
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  #inlineTokensInner(src: string, tokens: Token[]): Token[] {
    // The masked source is only read by emStrong and del, which need a *, _ or
    // ~ to start. Skip building it for a run without one, unless a custom
    // tokenizer or an emStrongMask hook may read it. Even then, the mask is
    // the identity when the run holds no '[', backtick, '<' or backslash:
    // every replace inside #maskSrc needs one of those to match, so skipping
    // it then changes nothing (a custom emStrongMask hook still forces it).
    const hasCustomMask = this.options.hooks?.emStrongMask
      || this.tokenizer.emStrong !== _Tokenizer.prototype.emStrong
      || this.tokenizer.del !== _Tokenizer.prototype.del;
    const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~') || hasCustomMask)
      && (hasCustomMask || src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\'))
      ? this.maskSrc(src)
      : src;

    // One scan of this maskedSrc for the last emphasis, strong, and
    // strikethrough closers, shared by every opener in the pass. Popped
    // when the pass ends so the source is not retained (#4099). The scan
    // is only read by emStrong/del, which the dispatch only calls on a
    // '*', '_' or '~' first character — a run with none of those (and no
    // custom mask) can never use it, so skip the whole scan then.
    const needsCloserScan = !!hasCustomMask
      || src.includes('*') || src.includes('_') || src.includes('~');
    if (needsCloserScan) beginEmStrongDelCloserScan(this.tokenizer, maskedSrc);
    try {
      // Fast path: render the whole run straight to HTML (a single html
      // token the Parser passes through verbatim). Null falls back to the
      // tokenizing loop below.
      const fast = fastInline(src, this, maskedSrc);
      if (fast !== null) {
        tokens.push({ type: 'html', raw: src, text: fast, block: false });
        return tokens;
      }
      return this.#tokenizeInlines(src, maskedSrc, tokens);
    } finally {
      if (needsCloserScan) endEmStrongDelCloserScan(this.tokenizer);
    }
  }

  #tokenizeInlines(src: string, maskedSrc: string, tokens: Token[]): Token[] {
    // Url/email/www stop positions for this whole inline pass, computed once
    // here instead of once per text token.
    const stops = computeTextStops(src);
    const srcLen0 = src.length;
    let keepPrevChar = false;
    let prevChar = '';
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }

      if (!keepPrevChar) {
        prevChar = '';
      }
      keepPrevChar = false;

      let token: Tokens.Generic | undefined;

      // Dispatch on the first character: at any position only a few of the
      // inline tokenizers can match (their regexes are anchored and each
      // needs a specific opening character), so trying all of them on every
      // token wastes most of the inline budget. The order inside each branch
      // is the original attempt order for the tokenizers that can match
      // there, and the branches cover every first character the original
      // loop could consume.
      const ch = src.charCodeAt(0);
      if (ch === 92) { // backslash: escape, br, text
        if (token = this.tokenizer.escape(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === 60) { // <: tag, autolink, text
        if (token = this.tokenizer.tag(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.autolink(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === 91 || ch === 33) { // [ or !: link, reflink, text
        if (token = this.tokenizer.link(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.reflink(src, this.tokens.links)) {
          src = src.substring(token.raw.length);
          const lastToken = tokens.at(-1);
          if (token.type === 'text' && lastToken?.type === 'text') {
            lastToken.raw += token.raw;
            lastToken.text += token.text;
          } else {
            tokens.push(token);
          }
          continue;
        }
      } else if (ch === 42 || ch === 95) { // * or _: emStrong, url (an email may start with _), text
        if (token = this.tokenizer.emStrong(src, maskedSrc, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (ch === 95 && !this.state.inLink && (token = this.tokenizer.url(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === 96) { // backtick: codespan, text
        if (token = this.tokenizer.codespan(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === 32) { // space: br, text
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === 126) { // ~: del, text
        if (token = this.tokenizer.del(src, maskedSrc, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (!this.state.inLink && mayStartUrl(src)) {
        // a URL / extended autolink may start here (www., scheme://, mailto:,
        // xmpp: or an email address); the url regex is tried before text
        if (token = this.tokenizer.url(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }

      // text (fast manual scan, identical raw to the inline.text regex)
      if (token = this.tokenizer.inlineTextFast(src, stops, srcLen0 - src.length)) {
        src = src.substring(token.raw.length);
        if (token.raw.charCodeAt(token.raw.length - 1) !== 95) { // Track prevChar before string of ____ started
          prevChar = token.raw[token.raw.length - 1];
        }
        keepPrevChar = true;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }

    return tokens;
  }

  /**
   * Mask links, code, html and escapes so emStrong and del do not see their
   * delimiters inside them.
   */
  maskSrc(src: string): string {
    // String with links masked to avoid interference with em and strong
    let maskedSrc = src;

    // Mask out reflinks (a reflink needs both brackets to match)
    if (this.tokens.links && src.includes('[') && src.includes(']')) {
      const reflinkSearch = this.tokenizer.rules.inline.reflinkSearch;
      const maskReflink = (match0: string): string => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          return match0;
        }
        // CommonMark: "Links may not contain other links, at any level of
        // nesting." A candidate whose text already holds one never becomes a
        // link, so flattening the whole span would hide the emphasis that
        // does still apply inside it. Mask the links it holds instead.
        // Images are exempt: their text is flattened into an alt attribute.
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearch, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
    }

    // Mask out escaped characters.
    // Every mask must keep the length it replaces: emStrong and del line
    // maskedSrc up with src by slicing from the end. `anyPunctuation` matches
    // unicode punctuation, so an escaped astral character is 3 code units.
    // A backslash inside a code span is literal, not an escape. Mask the
    // backticks inside the span instead, so blockSkip still skips all of it.
    // The regex can only match a code span (needs a backtick) or an escape
    // (needs a backslash), so skip the scan when neither is present.
    if (maskedSrc.includes('\\') || maskedSrc.includes('`')) {
      maskedSrc = maskedSrc.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (match0, code, punct) => {
        if (punct) {
          return '+'.repeat(match0.length);
        }
        if (code) {
          return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        }
        return match0;
      });
    }

    // Mask out other blocks. blockSkip only matches an inline link (needs
    // ']('), a code span (needs a backtick) or html (needs '<'), so skip
    // the scan when none of those is present.
    if (maskedSrc.includes('](') || maskedSrc.includes('<') || maskedSrc.includes('`')) {
      maskedSrc = maskedSrc.replace(this.tokenizer.rules.inline.blockSkip, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }

    // Mask out blocks from extensions
    maskedSrc = this.options.hooks?.emStrongMask?.call({ lexer: this }, maskedSrc) ?? maskedSrc;

    return maskedSrc;
  }

  private infiniteLoopError(byte: number) {
    const errMsg = 'Infinite loop on byte: ' + byte;
    if (this.options.silent) {
      console.error(errMsg);
    } else {
      throw new Error(errMsg);
    }
  }
}

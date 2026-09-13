/**
 * Reasoning ("thinking") text that some models emit before the answer.
 *
 * Providers hand it over three ways: a separate field (`reasoning_content`,
 * `thinking`), a typed part/block, or inline `<think>…</think>` tags in the
 * answer text. This module handles the inline form so every provider can
 * report it the same way: `reasoning` beside `text`, never mixed into it.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

export interface Split {
  text: string;
  reasoning: string;
}

/** Whole-answer form: pulls every `<think>…</think>` span out of `text`. */
export function splitThinkTags(text: string): Split {
  if (!text.includes(OPEN)) return { text, reasoning: '' };
  const filter = new ThinkFilter();
  const first = filter.push(text);
  const rest = filter.flush();
  const reasoning = (first.reasoning + rest.reasoning).trim();
  const answer = first.text + rest.text;
  return { text: reasoning ? answer.trimStart() : answer, reasoning };
}

/**
 * Streaming form: feed deltas, get back what is answer and what is thinking.
 * A tag split across two deltas (`<thi` + `nk>`) is held back until it is
 * known to be a tag or not, so no tag text ever leaks into the answer.
 */
export class ThinkFilter {
  private inside = false;
  private carry = '';

  push(delta: string): Split {
    let buf = this.carry + delta;
    this.carry = '';
    let text = '';
    let reasoning = '';
    for (;;) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = buf.indexOf(tag);
      if (at !== -1) {
        const before = buf.slice(0, at);
        if (this.inside) reasoning += before;
        else text += before;
        this.inside = !this.inside;
        buf = buf.slice(at + tag.length);
        continue;
      }
      // No full tag; keep a suffix that could be the start of one.
      const hold = partialTagLength(buf, tag);
      const emit = buf.slice(0, buf.length - hold);
      this.carry = buf.slice(buf.length - hold);
      if (this.inside) reasoning += emit;
      else text += emit;
      break;
    }
    return { text, reasoning };
  }

  /** End of stream: whatever was held back was not a tag after all. */
  flush(): Split {
    const out = this.carry;
    this.carry = '';
    return this.inside ? { text: '', reasoning: out } : { text: out, reasoning: '' };
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialTagLength(s: string, tag: string): number {
  const max = Math.min(tag.length - 1, s.length);
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}

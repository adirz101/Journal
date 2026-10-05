import { expect, type Locator, type Page } from '@playwright/test';

// Accessibility checks for the keyboard walkthroughs (Phase 9). They read the
// rendered page only; nothing here clicks.

// Presses Tab (Shift+Tab when `back`) until `target` has focus. Fails if it is not
// reached within `max` presses, which means it is not in the tab order.
export async function tabTo(page: Page, target: Locator, { max = 60, back = false } = {}) {
  for (let i = 0; i <= max; i++) {
    if (await target.evaluate(el => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`Not reached with ${back ? 'Shift+' : ''}Tab: ${target}`);
}

// What is wrong with the focused element's focus indicator, or null when it has a visible one.
// The focused element (and a tab's label, which carries the ring for tabs, or the palette's search
// row, which draws the ring for its input with :focus-within) is read with focus and
// again after blur(); an outline, a box-shadow ring or the border must change, and the new colour
// must be opaque enough and reach 3:1 (WCAG 1.4.11) against the background it is drawn on.
export function focusRingProblem(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'nothing focused';
    if (!el.matches(':focus-visible')) return null; // pointer focus: no ring required
    const parse = (c: string): number[] | null => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
    const over = (top: number[], base: number[]) => [0, 1, 2].map(i => top[i] * top[3] + base[i] * (1 - top[3]));
    const lum = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const background = (node: Element | null): number[] => {
      const layers: number[][] = [];
      for (let n = node; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
      let rgb = (parse(getComputedStyle(document.body).backgroundColor) ?? [0, 0, 0, 1]).slice(0, 3);
      for (const layer of layers.reverse()) rgb = over(layer, rgb); return rgb;
    };
    const targets = [el, el.querySelector<HTMLElement>('.panel-tab-label'), el.closest<HTMLElement>('.palette-search')].filter(Boolean) as HTMLElement[];
    const read = (t: HTMLElement) => { const s = getComputedStyle(t); return { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`, outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), outlineColor: s.outlineColor, offset: parseFloat(s.outlineOffset), shadow: s.boxShadow, border: `${s.borderTopColor} ${s.borderTopWidth}`, borderColor: s.borderTopColor, borderWidth: parseFloat(s.borderTopWidth) }; };
    const focused = targets.map(read);
    el.blur(); const blurred = targets.map(read); el.focus({ preventScroll: true });
    const problems: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const [f, b, t] = [focused[i], blurred[i], targets[i]];
      const behind = background(t.parentElement); const inside = background(t);
      const visible = (colour: string, against: number[]) => { const c = parse(colour); return !!c && c[3] > 0.1 && ratio(over(c, against), against) >= 3; };
      if (f.outline !== b.outline && f.outlineStyle !== 'none' && f.outlineWidth > 0 && visible(f.outlineColor, f.offset < 0 ? inside : behind)) return null;
      if (f.shadow !== b.shadow && f.shadow !== 'none') { const c = f.shadow.match(/rgba?\([^)]+\)/g) ?? []; if (c.some(colour => visible(colour, behind))) return null; }
      if (f.border !== b.border && f.borderWidth > 0 && visible(f.borderColor, behind)) return null;
      problems.push(`${f.outline} | ${f.shadow} | ${f.border} (blurred: ${b.outline} | ${b.shadow} | ${b.border})`);
    }
    return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ').join('.')}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}": ${problems.join('; ')}`;
  });
}

export async function expectVisibleFocus(page: Page) {
  expect(await focusRingProblem(page), 'focused element has no visible focus indicator').toBeNull();
}

export type Audit = { unnamed: string[]; contrast: string[]; terminalLive: string[]; liveRegions: number };

// Names, contrast and live regions of what is visible now.
// - unnamed: buttons, links, tabs, radios, checkboxes, comboboxes, listboxes, options, text fields and named regions without an accessible name;
// - contrast: visible text under 4.5:1 (3:1 at 18.66 px bold / 24 px) against its composited background;
// - terminalLive: live regions inside the terminal (they would speak every chunk).
export function audit(page: Page): Promise<Audit> {
  return page.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[hidden],[aria-hidden=true],[inert]'); };
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
    // Containers and composite widgets are not named by their content: a dialog, region, section,
    // listbox or combobox needs aria-labelledby, aria-label or a <label> (review I3).
    const ownNameOnly = 'dialog,[role=dialog],[role=listbox],[role=combobox],[role=region],section';
    const nameOf = (el: Element) => {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) return labelled.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      const aria = el.getAttribute('aria-label'); if (aria?.trim()) return aria.trim();
      if (el.matches(ownNameOnly)) return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? [...(el.labels ?? [])].map(l => l.textContent ?? '').join(' ').trim() : '';
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const labels = [...(el.labels ?? [])].map(l => l.textContent ?? '').join(' ').trim(); if (labels) return labels;
        return el.getAttribute('title') ?? el.getAttribute('placeholder') ?? '';
      }
      return ((el as HTMLElement).innerText || el.getAttribute('title') || '').trim();
    };
    const controls = 'button,a[href],[role=button],[role=tab],[role=radio],[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=combobox],[role=listbox],input:not([type=hidden]),textarea,select,[role=dialog],dialog[open],[role=region],section[aria-label],section[aria-labelledby],[role=list][aria-label]';
    const unnamed = [...document.querySelectorAll(controls)].filter(el => visible(el) && !el.closest('.xterm') && !nameOf(el)).map(describe);

    // Contrast: composite each ancestor's background (and opacity) down to the window.
    const parse = (c: string): number[] | null => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
    const over = (top: number[], base: number[]) => [0, 1, 2].map(i => top[i] * top[3] + base[i] * (1 - top[3]));
    const lum = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const background = (el: Element): number[] => {
      const layers: number[][] = [];
      for (let node: Element | null = el; node; node = node.parentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
      let base = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1]; if (base[3] < 1) base = [0, 0, 0, 1];
      let rgb = base.slice(0, 3); for (const layer of layers.reverse()) rgb = over(layer, rgb); return rgb;
    };
    const opacity = (el: Element) => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
    const contrast: string[] = []; const seen = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement; if (!el || !node.textContent?.trim() || !visible(el)) continue;
      if (el.closest('.xterm,.cm-editor,svg,[aria-disabled=true],:disabled,.visually-hidden')) continue; // terminal and editor themes are tested in tokens.test.mjs
      const s = getComputedStyle(el); const fg = parse(s.color); if (!fg) continue;
      const shown = opacity(el); if (shown < 0.05) continue; // revealed on hover or focus (opacity 0 until then)
      const bg = background(el); const alpha = fg[3] * shown;
      const r = ratio(over([fg[0], fg[1], fg[2], alpha], bg), bg);
      const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const key = `${describe(el)} ${r.toFixed(2)}`;
      if (r < need && !seen.has(key)) { seen.add(key); contrast.push(`${key} < ${need} "${node.textContent.trim().slice(0, 30)}"`); }
    }
    const terminalLive = [...document.querySelectorAll('.terminal-surface [aria-live]:not([aria-live=off]), .terminal-surface [role=status], .terminal-surface [role=log], .terminal-surface [role=alert]')].map(describe);
    const liveRegions = document.querySelectorAll('[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log]').length;
    return { unnamed, contrast, terminalLive, liveRegions };
  });
}

// Runs the audit in both themes (the theme attribute only; the app's own setting is
// restored), and expects no findings.
export async function expectAccessible(page: Page, where: string) {
  const original = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  try {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      // Entrances and theme transitions run to their end first: the audit reads settled colours.
      await page.evaluate(async () => { await new Promise(requestAnimationFrame); await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
      const result = await audit(page);
      expect(result.unnamed, `${where} (${theme}): controls without a name`).toEqual([]);
      expect(result.contrast, `${where} (${theme}): text under the contrast minimum`).toEqual([]);
      expect(result.terminalLive, `${where}: live regions inside the terminal`).toEqual([]);
    }
  } finally { await page.evaluate(t => { document.documentElement.dataset.theme = t; }, original); }
}

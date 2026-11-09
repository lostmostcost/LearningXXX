/** Serialized into the sandboxed renderer. No host calls or React state access. */
export function installAgentSurface() {
  type Target = { element: HTMLElement; signature: string };
  const targets = new Map<string, Target>();
  // Also invalidate when surrounding context changes (e.g. the active conversation),
  // even if a reused Send button keeps the same label and enabled state.
  const observer = new MutationObserver(() => targets.clear());
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const selector = 'button,a[href],input,textarea,select,summary,[role="button"],[role="tab"],[role="checkbox"],[role="slider"],[contenteditable="true"],[tabindex],.textLayer';
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const label = (el: HTMLElement): string => compact(el.getAttribute('aria-label') ||
    (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ') ||
    ('labels' in el ? Array.from((el as HTMLInputElement).labels ?? []).map(l => l.textContent).join(' ') : '') ||
    el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('alt') || el.tagName.toLowerCase()).slice(0, 1000);
  const modal = () => Array.from(document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]')).filter(el => el.checkVisibility()).at(-1);
  const point = (el: HTMLElement): { x: number; y: number } | undefined => {
    if (!el.isConnected || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || el.closest('[hidden],[inert],[aria-hidden="true"]')) return;
    const dialog = modal();
    if (dialog && !dialog.contains(el)) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    if (right <= left || bottom <= top) return;
    for (const [fx, fy] of [[.5, .5], [.1, .5], [.9, .5], [.5, .1], [.5, .9]]) {
      const x = left + (right - left) * fx!, y = top + (bottom - top) * fy!;
      const hit = document.elementFromPoint(x, y);
      if (hit && (el === hit || el.contains(hit))) return { x, y };
    }
    return;
  };
  const disabled = (el: HTMLElement) => el.matches(':disabled') || !!el.closest('[aria-disabled="true"]');
  const visiblePdfText = (el: HTMLElement): string => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), parts: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!parent?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || parent.closest('[hidden],[aria-hidden="true"]')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(r => r.width && r.height);
      if (rects.length && rects.every(r => {
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && !!hit && el.contains(hit);
      })) parts.push(node.textContent ?? '');
    }
    return parts.join('').slice(0, 20_000);
  };
  const signature = (el: HTMLElement) => JSON.stringify([el.tagName, label(el), el.getAttribute('role'), el.getAttribute('type'),
    'value' in el ? (el as HTMLInputElement).value : null, el.getAttribute('aria-expanded'), el.getAttribute('aria-pressed'),
    'checked' in el ? (el as HTMLInputElement).checked : null]);
  const snapshot = () => {
    targets.clear();
    const revision = crypto.randomUUID();
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(el => !!point(el));
    const controls = elements.map((el, i) => {
      const id = `${revision}:${i}`;
      targets.set(id, { element: el, signature: signature(el) });
      const secret = el instanceof HTMLInputElement && el.type === 'password';
      return { id, role: el.getAttribute('role') || el.tagName.toLowerCase(), name: label(el), disabled: disabled(el),
        context: el.closest('section[aria-label],nav[aria-label],aside[aria-label],[role="tablist"][aria-label],[role="dialog"]')?.getAttribute('aria-label') ?? '',
        ...(el.matches('.textLayer') ? { selectableText: visiblePdfText(el), page: el.closest('[data-page]')?.getAttribute('data-page'), ready: el.closest('[data-page]')?.getAttribute('data-ready') === 'true' } : {}),
        ...('value' in el && !secret ? { value: (el as HTMLInputElement).value } : {}),
        ...('checked' in el ? { checked: (el as HTMLInputElement).checked } : {}),
        ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') } : {}),
        ...(el.hasAttribute('aria-selected') ? { selected: el.getAttribute('aria-selected') } : {}),
        ...(el instanceof HTMLSelectElement ? { options: Array.from(el.options).map(o => ({ value: o.value, name: o.label, disabled: o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled) })) } : {}),
      };
    });
    // Only text actually painted in the viewport; closed trays and clipped panels stay absent.
    const text: string[] = [];
    const walker = document.createTreeWalker(modal() ?? document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!parent || parent.closest('script,style,textarea,input,select,[aria-hidden="true"]') || !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const value = compact(node.textContent ?? '');
      if (!value) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (Array.from(range.getClientRects()).some(r => {
        const x = Math.max(0, r.left) + Math.min(r.width, innerWidth - Math.max(0, r.left)) / 2;
        const y = Math.max(0, r.top) + Math.min(r.height, innerHeight - Math.max(0, r.top)) / 2;
        const hit = document.elementFromPoint(x, y);
        return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && !!hit && (parent === hit || parent.contains(hit));
      })) text.push(value);
    }
    return { revision, title: document.title, viewport: { width: innerWidth, height: innerHeight }, text: text.join('\n').slice(0, 60_000),
      focused: document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !!point(document.activeElement) ? label(document.activeElement) : null, controls };
  };
  const target = (id: string) => {
    const stored = targets.get(id);
    if (!stored || signature(stored.element) !== stored.signature || !point(stored.element)) throw new Error('STALE_TARGET: read a new snapshot');
    if (disabled(stored.element)) throw new Error('DISABLED: follow the displayed prerequisites');
    return stored.element;
  };
  const act = (command: { op: string; target?: string; text?: string; value?: string; dy?: number }) => {
    const el = target(command.target ?? '');
    targets.clear(); // One action per snapshot; retries cannot accidentally repeat an operation.
    if (command.op === 'click') {
      if (el.matches('input[type="file"]')) throw new Error('NATIVE_REQUIRED: file chooser cannot be bypassed');
      if (el instanceof HTMLAnchorElement && /^https?:/.test(el.href)) throw new Error('NATIVE_REQUIRED: external browser link');
      el.focus({ preventScroll: true }); el.click();
    } else if (command.op === 'focus') el.focus({ preventScroll: true });
    else if (command.op === 'fill') {
      if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type)) || el.readOnly) throw new Error('NOT_EDITABLE');
      if (el.maxLength >= 0 && (command.text ?? '').length > el.maxLength) throw new Error('INVALID_TEXT: input maximum length exceeded');
      el.focus({ preventScroll: true });
      const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!;
      if (el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: command.text ?? '' }))) {
        setter.call(el, command.text ?? '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.text ?? '' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (command.op === 'selectText') {
      if (!el.matches('.textLayer') || el.closest('[data-page]')?.getAttribute('data-ready') !== 'true') throw new Error('TEXT_UNAVAILABLE');
      const text = el.textContent ?? '', selected = command.text ?? '', start = text.indexOf(selected);
      if (!selected || start < 0 || text.indexOf(selected, start + 1) >= 0) throw new Error('TEXT_UNAVAILABLE: choose a unique visible substring');
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const boundary = (offset: number): [Text, number] => {
        for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; }
        throw new Error('TEXT_UNAVAILABLE');
      };
      const range = document.createRange(); range.setStart(...boundary(start)); range.setEnd(...boundary(start + selected.length));
      const rects = Array.from(range.getClientRects()).filter(r => r.width && r.height);
      if (!rects.length || !rects.every(r => {
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && !!hit && el.contains(hit);
      })) throw new Error('TEXT_NOT_VISIBLE: scroll first');
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    } else if (command.op === 'select') {
      if (!(el instanceof HTMLSelectElement)) throw new Error('NOT_SELECT');
      const option = Array.from(el.options).find(o => o.value === command.value);
      if (!option || option.disabled || option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) throw new Error('OPTION_UNAVAILABLE');
      el.focus({ preventScroll: true }); el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (command.op === 'scroll') {
      // Scroll the nearest scrollable ancestor, as a wheel over this visible element would.
      let scroller: HTMLElement | null = el;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      (scroller ?? document.scrollingElement)?.scrollBy({ top: command.dy ?? 0, behavior: 'instant' });
    } else throw new Error('UNKNOWN_OPERATION');
    return { performed: command.op };
  };
  const keyboard = (key: string) => {
    const el = document.activeElement;
    if (!['Tab', 'Escape', 'F6'].includes(key) && (!(el instanceof HTMLElement) || !point(el) || disabled(el))) throw new Error('FOCUS_REQUIRED: focus a visible enabled control');
    if (['Enter', 'Space'].includes(key) && el instanceof HTMLElement && (el.matches('input[type="file"]') || el instanceof HTMLAnchorElement && /^https?:/.test(el.href))) throw new Error('NATIVE_REQUIRED: external browser or file chooser');
    targets.clear();
  };
  return { snapshot, act, keyboard, invalidate: () => targets.clear() };
}

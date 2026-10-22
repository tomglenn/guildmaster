/** Use rendered transcript order, including questions and retained streaming text.
 * A quest's saved result can belong to a much older turn. Operational rows are
 * deliberately not message targets.
 */
export function latestMessageTarget(scroll: Element): HTMLElement | undefined {
  const messages = scroll.querySelectorAll<HTMLElement>('[data-message-id]');
  return messages[messages.length - 1];
}

export function latestMessageDirection(scroll: HTMLElement, target: HTMLElement): 'above' | 'below' | null {
  // Rounding and fractional layout can leave less than a pixel at the bottom.
  // Never offer an upward jump from the end of the conversation (even when
  // operational evidence follows the final message).
  if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1) return null;
  const viewport = scroll.getBoundingClientRect();
  const top = viewport.top + scroll.clientTop;
  const bottom = top + scroll.clientHeight;
  const message = target.getBoundingClientRect();
  return message.bottom <= top ? 'above' : message.top >= bottom ? 'below' : null;
}

export function observeLatestMessage(scroll: HTMLElement, update: (direction: 'above' | 'below' | null) => void): () => void {
  let target: HTMLElement | undefined;
  let content: Element | null = null;
  const refresh = () => {
    const next = latestMessageTarget(scroll);
    // Saved messages may replace a streaming DOM node with the same ID.
    if (target !== next) {
      if (target) observer.unobserve(target);
      target = next;
      if (target) observer.observe(target);
    }
    if (content !== scroll.firstElementChild) {
      if (content) observer.unobserve(content);
      content = scroll.firstElementChild;
      if (content) observer.observe(content);
    }
    update(target ? latestMessageDirection(scroll, target) : null);
  };
  const observer = new ResizeObserver(refresh);
  const mutations = new MutationObserver(refresh);
  observer.observe(scroll);
  mutations.observe(scroll, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-message-id'] });
  scroll.addEventListener('scroll', refresh, { passive: true });
  refresh();
  return () => {
    observer.disconnect();
    mutations.disconnect();
    scroll.removeEventListener('scroll', refresh);
  };
}

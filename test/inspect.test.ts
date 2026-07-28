import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  elementForNodeId,
  hasFuaranMarkup,
  markedElementCount,
  nodeIdForElement,
} from '../src/inspect/detect.js';
import { hideHighlight, OVERLAY_ID, showHighlight } from '../src/inspect/overlay.js';
import { startPicking } from '../src/inspect/picker.js';

const mount = (html: string): void => {
  document.body.innerHTML = html;
};

const PAGE = `
  <div data-fuaran-node-id="root">
    <section data-fuaran-node-id="metric-1"><span id="inner">42</span></section>
    <button data-fuaran-node-id="btn-1" id="btn">Go</button>
  </div>
  <p id="outside">not Fuaran</p>
`;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('detection', () => {
  it('reports a page with no Fuaran markup', () => {
    mount('<p>nothing here</p>');
    expect(hasFuaranMarkup(document)).toBe(false);
    expect(markedElementCount(document)).toBe(0);
  });

  it('finds marked elements and counts them', () => {
    mount(PAGE);
    expect(hasFuaranMarkup(document)).toBe(true);
    expect(markedElementCount(document)).toBe(3);
  });

  it('walks up from an unmarked click target to its owning node', () => {
    mount(PAGE);
    // The click almost always lands on an inner, unmarked element; without the
    // walk up, click-to-select would resolve to nothing most of the time.
    expect(nodeIdForElement(document.getElementById('inner'))).toBe('metric-1');
    expect(nodeIdForElement(document.getElementById('outside'))).toBeUndefined();
    expect(nodeIdForElement(null)).toBeUndefined();
  });

  it('resolves a node id back to its element', () => {
    mount(PAGE);
    expect(elementForNodeId(document, 'btn-1')?.id).toBe('btn');
    expect(elementForNodeId(document, 'absent')).toBeNull();
  });

  it('survives a node id carrying selector metacharacters', () => {
    mount('<div data-fuaran-node-id="a.b[0]"></div>');
    expect(elementForNodeId(document, 'a.b[0]')).not.toBeNull();
  });
});

describe('highlight overlay', () => {
  it('draws one overlay, out of flow and non-interactive', () => {
    mount(PAGE);
    expect(showHighlight(document, 'metric-1', 'Metric')).toBe(true);

    const overlay = document.getElementById(OVERLAY_ID);
    expect(overlay).not.toBeNull();
    const style = overlay?.getAttribute('style') ?? '';
    // No reflow: fixed positioning takes it out of flow, and pointer-events
    // none keeps it from swallowing a click meant for the page.
    expect(style).toContain('position:fixed');
    expect(style).toContain('pointer-events:none');
    expect(overlay?.textContent).toBe('Metric · metric-1');
  });

  it('replaces rather than stacks, and clears cleanly', () => {
    mount(PAGE);
    showHighlight(document, 'metric-1');
    showHighlight(document, 'btn-1');
    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);

    hideHighlight(document);
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    hideHighlight(document); // idempotent
  });

  it('reports a node with no mounted element rather than drawing nothing', () => {
    mount(PAGE);
    expect(showHighlight(document, 'never-rendered')).toBe(false);
  });

  it('renders an id as text, never as markup', () => {
    mount('<div data-fuaran-node-id="&lt;img src=x&gt;"></div>');
    showHighlight(document, '<img src=x>');
    const overlay = document.getElementById(OVERLAY_ID);
    expect(overlay?.querySelector('img')).toBeNull();
    expect(overlay?.textContent).toBe('<img src=x>');
  });
});

describe('click-to-select', () => {
  it('picks the owning node and swallows the click', () => {
    mount(PAGE);
    const onPick = vi.fn();
    const pressed = vi.fn();
    document.getElementById('btn')?.addEventListener('click', pressed);

    startPicking(document, { onPick, onHover: vi.fn(), onCancel: vi.fn() });
    document.getElementById('btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onPick).toHaveBeenCalledWith('btn-1');
    // An inspector that fires the app's own handlers is not an inspector.
    expect(pressed).not.toHaveBeenCalled();
  });

  it('reports hover changes once per node, not once per event', () => {
    mount(PAGE);
    const onHover = vi.fn();
    startPicking(document, { onHover, onPick: vi.fn(), onCancel: vi.fn() });

    const inner = document.getElementById('inner');
    inner?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    inner?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    document.getElementById('btn')?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    expect(onHover.mock.calls.map((call) => call[0])).toEqual(['metric-1', 'btn-1']);
  });

  it('cancels on Escape and detaches every listener', () => {
    mount(PAGE);
    const onCancel = vi.fn();
    const onPick = vi.fn();
    startPicking(document, { onCancel, onPick, onHover: vi.fn() });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Picking is over: a later click is the page's own again.
    document.getElementById('btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('cancels when the click lands on bare page', () => {
    mount(PAGE);
    const onCancel = vi.fn();
    startPicking(document, { onCancel, onPick: vi.fn(), onHover: vi.fn() });
    document.getElementById('outside')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('leaves the page untouched when the disposer runs first', () => {
    mount(PAGE);
    const onPick = vi.fn();
    const stop = startPicking(document, { onPick, onHover: vi.fn(), onCancel: vi.fn() });
    stop();
    stop(); // safe twice
    document.getElementById('btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();
  });
});

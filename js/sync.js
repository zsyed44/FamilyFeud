/* Local storage + cross-window messaging between the host console and the display.
 * Uses three redundant paths so it works on localhost AND when opened straight from disk:
 *   1. BroadcastChannel   2. window.postMessage (opener / popup / preview iframe)   3. localStorage events */
(function (F) {
  'use strict';

  F.KEYS = {
    game: 'feud.game.v1',
    undo: 'feud.undo.v1',
    settings: 'feud.settings.v1',
    pack: 'feud.pack.v1',
    view: 'feud.view.v1',
    pub: 'feud.public.v1',
    fx: 'feud.fx.v1',
    history: 'feud.history.v1',
  };

  F.Store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
  };

  F.createChannel = function (onMessage) {
    let bc = null;
    try { bc = new BroadcastChannel('feud-v1'); bc.onmessage = (e) => onMessage(e.data, null); } catch (e) { bc = null; }
    window.addEventListener('message', (e) => { if (e.data && e.data.__feud) onMessage(e.data, e.source); });
    return {
      send(msg, extraTargets) {
        msg.__feud = 1;
        if (bc) { try { bc.postMessage(msg); } catch (e) { /* ignore */ } }
        (extraTargets || []).forEach((w) => { try { if (w && !w.closed) w.postMessage(msg, '*'); } catch (e) { /* ignore */ } });
      },
    };
  };

  F.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
})(window.Feud = window.Feud || {});

// GNOME 48.x overlay version

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// ---- Config ----
const BASE = 'https://lod.lu';
const LOCALE = 'lb';
const WANT_LANGS = ['en', 'fr', 'de'];

// Overlay layout knobs
const CORNER = 'top-left';      // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
const OFFSET_PCT = 0.03;        // margin from edges as fraction of min(w,h)
const TEXT_SCALE = 0.55;        // < 1.0 makes it smaller
const PANEL_OPACITY = 0.45;     // 0..1 background box opacity

// Refresh interval (seconds)
const REFRESH_SECS = 60 * 60;   // hourly

const WotdWallpaper = GObject.registerClass(
class WotdWallpaper extends GObject.Object {
  _init() {
    super._init();
    this._soup = new Soup.Session();
    this._timeoutId = 0;

    // Overlays per monitor
    this._overlays = [];

    // Monitor-change handling
    this._monitorsChangedId = 0;
    this._monitorManager = null;
  }

  enable() {
    this._setupOverlays();
    this._refresh();

    this._timeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT, REFRESH_SECS, () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  disable() {
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = 0;
    }
    try { this._soup.abort(); } catch {}
    this._teardownOverlays();
  }

  // ---------------- Fetching & parsing ----------------

  async _refresh() {
    try {
      const wotd = await this._fetchJson(`${BASE}/api/${LOCALE}/word-of-the-day`);
      const lodId = wotd?.lod_id;
      const lemma = wotd?.lemma || '';
      const date = wotd?.start_at || '';

      if (!lodId || !lemma)
        throw new Error('Missing lod_id/lemma from WOTD API');

      const entry = await this._fetchJson(`${BASE}/api/${LOCALE}/entry/${lodId}`);
      const translations = this._extractTranslations(entry, WANT_LANGS);

      this._updateOverlayText(lemma, date, translations);
    } catch (e) {
      console.error(e);
      Main.notifyError('WOTD Overlay', e.message ?? String(e));
    }
  }

  async _fetchJson(url) {
    const msg = Soup.Message.new('GET', url);
    msg.request_headers.append('Accept', 'application/json');
    msg.request_headers.append('User-Agent', 'GNOME-WOTD/overlay/1.0');

    const bytes = await new Promise((resolve, reject) => {
      this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
        try { resolve(s.send_and_read_finish(res)); }
        catch (err) { reject(err); }
      });
    });

    if (msg.get_status() !== Soup.Status.OK)
      throw new Error(`HTTP ${msg.get_status()} for ${url}`);

    const txt = new TextDecoder().decode(bytes.get_data());
    return JSON.parse(txt);
  }

  _extractTranslations(entryJson, wanted) {
    const out = Object.fromEntries(wanted.map(w => [w, []]));
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;

      // Main shape: node.targetLanguages.{en,fr,de} -> strings or {content}
      if (n.targetLanguages && typeof n.targetLanguages === 'object') {
        for (const lang of wanted) {
          const vals = n.targetLanguages[lang];
          if (!vals) continue;
          if (Array.isArray(vals)) {
            for (const v of vals) {
              if (typeof v === 'string') out[lang].push(v.trim());
              else if (v && typeof v === 'object' && typeof v.content === 'string')
                out[lang].push(v.content.trim());
            }
          } else if (typeof vals === 'string') {
            out[lang].push(vals.trim());
          }
        }
      }

      // Fallback: { en: { parts: [{content: "..."}] } }
      for (const lang of wanted) {
        const block = n[lang];
        if (block && typeof block === 'object' && Array.isArray(block.parts)) {
          for (const p of block.parts) {
            if (p && typeof p === 'object' && typeof p.content === 'string')
              out[lang].push(p.content.trim());
          }
        }
      }

      for (const v of Object.values(n)) walk(v);
    };
    walk(entryJson);

    // Dedup + trim
    for (const k of wanted) {
      const seen = new Set();
      out[k] = out[k].filter(x => x && !seen.has(x) && seen.add(x)).slice(0, 3);
    }
    return out;
  }

  // ---------------- Overlay UI ----------------

  _setupOverlays() {
    this._teardownOverlays();

    // Prefer Shell's view of monitors
    const monitors = Main.layoutManager.monitors; // array of monitor objects
    const bgGroup = Main.layoutManager._backgroundGroup; // background layer

    for (let i = 0; i < monitors.length; i++) {
      const m = monitors[i];

      // Robust geometry extraction: geometry -> rect -> top-level fields
      const geo =
        m?.geometry ??
        m?.rect ??
        (m && ('x' in m && 'y' in m && 'width' in m && 'height' in m)
          ? { x: m.x, y: m.y, width: m.width, height: m.height }
          : null);

      if (!geo) {
        console.error(new Error('WOTD: Could not determine monitor geometry'));
        continue;
      }

      const margin = Math.floor(Math.min(geo.width, geo.height) * OFFSET_PCT);

      // Full-monitor container (non-interactive)
      const box = new St.Widget({
        reactive: false,
        x: geo.x, y: geo.y,
        width: geo.width, height: geo.height,
      });

      // Panel for readability
      const panel = new St.BoxLayout({ vertical: true, reactive: false });
      panel.set_style(
        `background-color: rgba(0,0,0,${PANEL_OPACITY});
         border-radius: 14px;
         padding: 8px 12px;
         max-width: ${Math.floor(geo.width * 0.9)}px;`
      );

      // Labels
      const titleLabel = new St.Label({ text: '', reactive: false });
      const metaLabel  = new St.Label({ text: '', reactive: false });

      // Font sizes scaled per monitor
      const titlePx = Math.max(16, Math.floor(geo.width * 0.06 * TEXT_SCALE));
      const metaPx  = Math.max(10, Math.floor(geo.width * 0.022 * TEXT_SCALE));
      titleLabel.set_style(`font-weight: 800; font-size: ${titlePx}px; color: white;`);
      metaLabel.set_style(`font-size: ${metaPx}px; color: white; margin-top: ${Math.floor(metaPx * 0.6)}px;`);

      panel.add_child(titleLabel);
      panel.add_child(metaLabel);
      box.add_child(panel);

      bgGroup.add_child(box);

      const overlay = { box, panel, titleLabel, metaLabel, monitor: i, geo, margin, titlePx, metaPx };
      this._overlays.push(overlay);

      // Initial positioning (after allocation so we know panel size)
      panel.connect('notify::width', () => this._positionPanel(overlay));
      panel.connect('notify::height', () => this._positionPanel(overlay));
      this._positionPanel(overlay);
    }

    // Rebuild overlays on monitor changes — listen on the monitor manager, not MetaDisplay
    if (!this._monitorsChangedId) {
      this._monitorManager =
        global.display.get_monitor_manager?.() ??
        global.backend?.get_monitor_manager?.() ?? null;

      if (this._monitorManager) {
        this._monitorsChangedId = this._monitorManager.connect('monitors-changed', () => this._setupOverlays());
      } else {
        console.warn('WOTD: no monitor manager found; monitor change handling disabled');
      }
    }
  }

  _teardownOverlays() {
    if (this._monitorsChangedId && this._monitorManager) {
      try { this._monitorManager.disconnect(this._monitorsChangedId); } catch {}
    }
    this._monitorsChangedId = 0;
    this._monitorManager = null;

    for (const o of this._overlays) {
      try { o.box?.destroy(); } catch {}
    }
    this._overlays = [];
  }

  _positionPanel(o) {
    // Compute screen-cornered position based on actual panel size
    const { geo, margin, panel } = o;
    const pw = panel.width  || panel.get_width?.()  || 0;
    const ph = panel.height || panel.get_height?.() || 0;

    let x = margin, y = margin;
    switch (CORNER) {
      case 'top-right':    x = geo.width - margin - pw;  y = margin; break;
      case 'bottom-left':  x = margin;                   y = geo.height - margin - ph; break;
      case 'bottom-right': x = geo.width - margin - pw;  y = geo.height - margin - ph; break;
      case 'top-left':
      default:             x = margin; y = margin; break;
    }

    panel.set_position(x, y);
  }

  _updateOverlayText(lemma, date, tr) {
    const lines = [];
    if (date) lines.push(date);
    if (tr?.en?.length) lines.push('EN: ' + tr.en.join(', '));
    if (tr?.fr?.length) lines.push('FR: ' + tr.fr.join(', '));
    if (tr?.de?.length) lines.push('DE: ' + tr.de.join(', '));
    const metaText = lines.join('\n');

    for (const o of this._overlays) {
      o.titleLabel.set_text(lemma);
      o.metaLabel.set_text(metaText);

      // Re-position after text changes (panel size may change)
      this._positionPanel(o);
    }
  }
});

export default class LuxWotdExtension extends Extension {
  enable() {
    this._impl = new WotdWallpaper();
    this._impl.enable();
  }
  disable() {
    this._impl?.disable();
    this._impl = null;
  }
}


// PanelController — the floating rail and its detail card.
//
// The macOS original is one non-activating NPanel sized card+rail always. On
// Windows a transparent window still owns its empty pixels for hit-testing,
// so instead there are two unfocusable windows: the rail (exactly the pill)
// and the card (exactly the bubble), each only as big as what it draws.
// Non-activating maps to focusable:false; the rail is placed and dragged by
// the controller, the card by hover alone.
'use strict';

const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const SLOT = 62;        // one ring + its label
const THICK = 62;       // rail thickness
const PAD = 10;         // rail end padding
const SLIVER = 6;       // collapsed thickness
const DOCK_DIST = 28;   // how close a drag must get to fuse to an edge
const CARD_W = 322;
const CARD_GAP = 10;
const HOVER_POLL_MS = 100;
const HOVER_MISS_MAX = 4;

const PRELOAD = path.join(__dirname, '..', 'preload', 'api.js');

function panelWindowOpts(extra) {
  return Object.assign({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }, extra);
}

class PanelController {
  constructor(settings, broadcast) {
    this.settings = settings;
    this.broadcast = broadcast;

    const p = settings.get('panel');
    this.dock = p.dock || 'right';          // 'left'|'right'|'top'|'free'
    this.freeAxis = p.freeAxis || 'vertical';
    this.ratio = typeof p.ratio === 'number' ? p.ratio : 0.5;
    this.free = { x: p.freeX, y: p.freeY }; // free placement, window coords
    this.slotCount = 0;
    this.collapsed = false;
    this.hoverMisses = 0;
    this.lastSnapshot = null;

    this.win = new BrowserWindow(panelWindowOpts({ width: THICK, height: PAD * 2 }));
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));

    this.cardWin = new BrowserWindow(panelWindowOpts({ width: CARD_W, height: 200 }));
    this.cardWin.setAlwaysOnTop(true, 'screen-saver');
    this.cardWin.loadFile(path.join(__dirname, '..', 'renderer', 'card.html'));

    this.wire();
  }

  wire() {
    ipcMain.on('panel:ready', () => {
      this.sendLayout();
      if (this.lastSnapshot && !this.panelGone()) this.win.webContents.send('state', this.lastSnapshot);
    });
    ipcMain.on('card:ready', () => { /* card waits for show() */ });

    // Drag: renderer owns the pointer capture and streams screen coords.
    ipcMain.on('drag:move', (_e, sx, sy, grabDX, grabDY) => this.dragMove(sx, sy, grabDX, grabDY));
    ipcMain.on('drag:end', () => this.persistPlacement());

    // Hover → card.
    ipcMain.on('card:show', (_e, accountId, ringScreenY) => this.showCard(accountId, ringScreenY));
    ipcMain.on('card:size', (_e, h) => this.sizeCard(h));
    ipcMain.on('card:hideSoon', () => this.hideCardSoon());
    ipcMain.on('rail:contextmenu', (_e, sx, sy) => {
      if (this.contextMenuAt) this.contextMenuAt(sx, sy);
    });
    ipcMain.on('rail:collapse', (_e, on) => {
      // Expanding needs a real cursor move since the collapse: when the window
      // shrinks under a parked cursor Windows re-fires mouseenter without any
      // movement, and that must not pop the rail back open.
      if (!on && this.collapseCursor) {
        const p = screen.getCursorScreenPoint();
        if (p.x === this.collapseCursor.x && p.y === this.collapseCursor.y) return;
      }
      this.collapseCursor = null;
      this.setCollapsed(on);
    });
    ipcMain.on('sliver:alertTint', (_e, color) => { this.sliverAlert = color; });
    ipcMain.on('provider:refresh', (_e, id) => { if (this.refreshProvider) this.refreshProvider(id); });
  }

  // ---------- geometry ----------

  // The rail window can die while the card/renderer still have IPC in flight
  // (quit races, renderer teardown). Everything touching this.win goes
  // through this guard instead of crashing on getBounds().
  panelGone() { return !this.win || this.win.isDestroyed(); }

  slots() { return Math.max(this.slotCount, 1); }
  railLength() { return PAD * 2 + this.slots() * SLOT; }
  axis() { return this.dock === 'top' ? 'horizontal' : (this.dock === 'free' ? this.freeAxis : 'vertical'); }
  thickness() { return this.collapsed ? SLIVER : THICK; }

  display() {
    // The display the rail lives on: the one containing the rail's center if
    // placed, else nearest the saved anchor, else primary.
    if (this.panelGone()) return screen.getPrimaryDisplay();
    const b = this.win.getBounds();
    if (b.width > SLIVER + 4 || this.placed) {
      return screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    }
    return screen.getPrimaryDisplay();
  }

  workArea() { return this.display().workArea; }

  computeBounds() {
    const wa = this.workArea();
    const len = this.railLength();
    const t = this.thickness();
    const axis = this.axis();

    if (this.dock === 'right' || this.dock === 'left') {
      const y = Math.round(wa.y + this.ratio * (wa.height - len));
      const x = this.dock === 'right' ? wa.x + wa.width - t : wa.x;
      return { x, y, width: t, height: len };
    }
    if (this.dock === 'top') {
      const x = Math.round(wa.x + this.ratio * (wa.width - len));
      return { x, y: wa.y, width: len, height: t };
    }
    // free
    const w = axis === 'horizontal' ? len : t;
    const h = axis === 'horizontal' ? t : len;
    let x = this.free.x != null ? this.free.x : wa.x + wa.width - w - 60;
    let y = this.free.y != null ? this.free.y : wa.y + Math.round((wa.height - h) / 2);
    x = Math.min(Math.max(x, wa.x - w + 40), wa.x + wa.width - 40);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - 40);
    return { x: Math.round(x), y: Math.round(y), width: w, height: h };
  }

  place() {
    if (this.panelGone()) return;
    const b = this.computeBounds();
    this.win.setBounds(b);
    this.placed = true;
    this.sendLayout();
  }

  reposition() { if (this.placed) this.place(); }

  rebuild() {
    this.slotCount = (this.settings.get('enabledAccounts') || []).length;
    if (this.placed) this.place();
  }

  sendLayout() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('layout', {
        axis: this.axis(), dock: this.dock,
        collapsed: this.collapsed,
        thickness: this.thickness(), slot: SLOT, pad: PAD,
        alertTint: this.sliverAlert || null,
      });
    }
  }

  // ---------- visibility ----------

  show() {
    if (this.panelGone()) return;
    this.rebuild();
    this.place();
    this.win.showInactive();
  }
  hide() { this.hideCard(true); if (!this.panelGone()) this.win.hide(); }
  isVisible() { return !this.panelGone() && this.win.isVisible(); }

  updateState(snap) { this.lastSnapshot = snap; }

  // ---------- drag & docking ----------

  // The pointer's screen position each frame; the window follows, and fuses
  // to an edge when it gets close — during the drag, not on mouse-up.
  dragMove(sx, sy, grabDX, grabDY) {
    if (this.panelGone()) return;
    this.hideCard(true);
    const wa = this.workArea();
    const axisBefore = this.axis();
    const len = this.railLength();

    // Candidate window position from the grab offset.
    let nx = sx - grabDX, ny = sy - grabDY;
    const b = this.win.getBounds();

    const nearL = Math.abs(nx - wa.x) <= DOCK_DIST || sx - wa.x <= DOCK_DIST;
    const nearR = Math.abs((nx + b.width) - (wa.x + wa.width)) <= DOCK_DIST || (wa.x + wa.width) - sx <= DOCK_DIST;
    const nearT = Math.abs(ny - wa.y) <= DOCK_DIST || sy - wa.y <= DOCK_DIST;

    // Pointer proximity decides the edge, then the axis falls out of it.
    let dock = this.dock;
    if (nearR && (!nearT || sx > wa.x + wa.width - DOCK_DIST)) dock = 'right';
    else if (nearL && (!nearT || sx < wa.x + DOCK_DIST)) dock = 'left';
    else if (nearT) dock = 'top';

    if (dock !== 'free' && dock !== this.dock) {
      this.dock = dock;
      // Keep the ratio from the pointer's position along the new axis.
      this.ratio = this.dock === 'top'
        ? clamp((sx - wa.x - len / 2) / Math.max(wa.width - len, 1), 0, 1)
        : clamp((sy - wa.y - len / 2) / Math.max(wa.height - len, 1), 0, 1);
    }

    if (dock !== 'free') {
      this.dock = dock;
      this.ratio = dock === 'top'
        ? clamp((sx - wa.x - len / 2) / Math.max(wa.width - len, 1), 0, 1)
        : clamp((sy - wa.y - len / 2) / Math.max(wa.height - len, 1), 0, 1);
      this.place();
      return;
    }

    // Free placement: rail keeps the axis it had, follows the pointer.
    if (this.dock !== 'free') { this.dock = 'free'; this.freeAxis = axisBefore; }
    const axis = this.freeAxis;
    const w = axis === 'horizontal' ? len : this.thickness();
    const h = axis === 'horizontal' ? this.thickness() : len;
    nx = sx - grabDX; ny = sy - grabDY;
    // A free upright rail stands off the sides; a free horizontal one may go flush.
    const minX = axis === 'horizontal' ? wa.x : wa.x + 6;
    const maxX = axis === 'horizontal' ? wa.x + wa.width - w : wa.x + wa.width - w - 6;
    this.free = {
      x: Math.min(Math.max(nx, minX), maxX),
      y: Math.min(Math.max(ny, wa.y), wa.y + wa.height - h),
    };
    this.win.setBounds({ x: Math.round(this.free.x), y: Math.round(this.free.y), width: w, height: h });
    this.sendLayout();
  }

  persistPlacement() {
    this.settings.patchPanel({
      dock: this.dock, ratio: this.ratio,
      freeX: this.free.x, freeY: this.free.y, freeAxis: this.freeAxis,
    });
  }

  // ---------- collapse ----------

  setCollapsed(on) {
    on = !!on;
    if (this.collapsed === on) return;
    this.collapsed = on;
    if (on) { this.collapseCursor = screen.getCursorScreenPoint(); this.hideCard(true); }
    this.place();
  }

  // ---------- the detail card ----------

  // The card opens toward the roomier side of the rail and aims its tail at
  // the pointed ring. Only pointer position decides when it closes — the
  // same approach the macOS build uses (sample, never trust an exit event).
  // ringPos is the ring's screen-center along the cross axis: Y for a
  // vertical rail, X for a horizontal one — the renderer knows which.
  showCard(accountId, ringPos) {
    if (this.collapsed || this.panelGone()) return;
    this.cardAccount = accountId;
    this.cardRingPos = ringPos;
    this.hoverMisses = 0;

    const cw = this.cardWin;
    const content = { accountId, ringScreenY: ringPos, dock: this.dock, axis: this.axis() };
    if (cw.isDestroyed()) return;
    cw.webContents.send('card:account', content);
    // If the card was already up, reposition now; otherwise it shows after
    // the renderer reports its height (card:size → sizeCard).
    if (cw.isVisible()) this.positionCard();
    this.startHoverWatch();
  }

  sizeCard(h) {
    const cw = this.cardWin;
    if (!cw || cw.isDestroyed() || this.panelGone()) return;
    this.cardH = Math.max(80, Math.min(Math.ceil(h), 560));
    this.positionCard();
    if (!cw.isVisible()) cw.showInactive();
  }

  positionCard() {
    if (this.panelGone() || !this.cardWin || this.cardWin.isDestroyed()) return;
    // computeBounds, not getBounds: during a collapse/expand transition the OS
    // window rect lags the intent, and the card must aim at where the rail IS.
    const rb = this.computeBounds();
    const wa = this.workArea();
    const h = this.cardH || 200;
    const axis = this.axis();
    let x, y, tail;

    if (axis === 'vertical') {
      // Roomier side wins: at the right edge the card grows left, and vice versa.
      const opensLeft = this.dock === 'right' ||
        (this.dock === 'free' && rb.x + rb.width / 2 > wa.x + wa.width / 2);
      x = opensLeft ? rb.x - CARD_W - CARD_GAP : rb.x + rb.width + CARD_GAP;
      const ringY = this.cardRingPos != null ? this.cardRingPos : rb.y + rb.height / 2;
      y = clamp(ringY - 46, wa.y + 8, wa.y + wa.height - h - 8);
      tail = { side: opensLeft ? 'right' : 'left', offset: Math.round(ringY - y) };
    } else {
      // Horizontal rail: card hangs below the rail, or stands above near the
      // bottom edge. The tail sits on top/bottom aimed at the ring's center.
      const cx = this.cardRingPos != null ? this.cardRingPos : rb.x + rb.width / 2;
      const opensDown = this.dock === 'top' || (this.dock === 'free' && rb.y + rb.height / 2 < wa.y + wa.height / 2);
      y = opensDown ? rb.y + rb.height + CARD_GAP : rb.y - h - CARD_GAP;
      x = clamp(cx - CARD_W / 2, wa.x + 8, wa.x + wa.width - CARD_W - 8);
      tail = { side: opensDown ? 'top' : 'bottom', offset: Math.round(cx - x) };
    }

    this.cardWin.setBounds({ x: Math.round(x), y: Math.round(y), width: CARD_W, height: h });
    this.cardWin.webContents.send('card:tail', tail);
  }

  // Pointer sampling: the card stays while the cursor is inside either
  // window; a few consecutive misses close it.
  startHoverWatch() {
    if (this.hoverTimer) return;
    this.hoverTimer = setInterval(() => {
      if (this.panelGone() || !this.cardWin || this.cardWin.isDestroyed() || !this.cardWin.isVisible()) {
        this.stopHoverWatch();
        return;
      }
      const pt = screen.getCursorScreenPoint();
      const inRail = pointIn(pt, this.win.getBounds());
      const inCard = pointIn(pt, this.cardWin.getBounds());
      if (inRail || inCard) { this.hoverMisses = 0; return; }
      if (++this.hoverMisses >= HOVER_MISS_MAX) this.hideCard();
    }, HOVER_POLL_MS);
  }

  stopHoverWatch() {
    if (this.hoverTimer) { clearInterval(this.hoverTimer); this.hoverTimer = null; }
  }

  hideCardSoon() { this.hoverMisses = Math.max(this.hoverMisses, HOVER_MISS_MAX - 1); }

  hideCard(now) {
    const was = this.cardWin && !this.cardWin.isDestroyed() && this.cardWin.isVisible();
    if (this.cardWin && !this.cardWin.isDestroyed()) this.cardWin.hide();
    this.stopHoverWatch();
    // The rail re-arms its idle collapse once the card is gone.
    if (was && this.win && !this.win.isDestroyed()) this.win.webContents.send('card:closed');
  }
}

function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
function pointIn(pt, b) {
  return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
}

module.exports = { PanelController, SLOT, THICK, PAD };

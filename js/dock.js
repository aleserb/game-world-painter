// The window layout of GameWorld Painter: the map, the tool options, the layers, the properties and the 3D preview are
// dockable panels (dockview-core, vendor/). Drag a tab to dock the panel at another side or into another group as a
// tab, Shift+drag it to float, drag the splitters to resize; right-click a tab to maximize, float or reset the layout.
// The layout is kept in the browser (localStorage).
(function (ME) {
  'use strict';

  const DV = window['dockview-core'];

  const PANELS = {
    map: { title: 'Map', node: '#stage', fixed: true },
    layers: { title: 'Layers', node: '#layers', fixed: true },
    tool: { title: 'Tool Options', node: '#options', fixed: true },
    props: { title: 'Properties', node: '#props', fixed: true },
    view3d: { title: '3D Preview', node: '#view3d', fixed: false },
  };

  /** A tab without the close button, for the panels that are always there. */
  function fixedTab() {
    const element = document.createElement('div'), content = document.createElement('div');
    element.className = 'dv-default-tab';
    content.className = 'dv-default-tab-content';
    element.append(content);
    return { element, init: p => { content.textContent = p.title; } };
  }

  class Dock {
    /** container: the element of the dock; storageKey: localStorage key of the layout; onRemove(id): a panel closed;
     *  onReset(): the layout was reset (the panels of the first start are there again). */
    constructor(container, { storageKey, onRemove, onReset }) {
      this.key = storageKey;
      this.onRemove = onRemove;
      this.onReset = onReset;
      this.nodes = {};
      for (const [id, p] of Object.entries(PANELS)) this.nodes[id] = document.querySelector(p.node);
      this.api = DV.createDockview(container, {
        theme: DV.themeDark,
        defaultRenderer: 'always', // keep the content (canvases) alive when a tab is hidden or moved
        createComponent: ({ id }) => {
          const element = document.createElement('div');
          element.className = 'dock-panel';
          return { element, init: () => { if (this.nodes[id]) element.append(this.nodes[id]); } };
        },
        createTabComponent: ({ name }) => (name === 'fixed' ? fixedTab() : undefined),
        getTabContextMenuItems: ({ panel }) => [
          'maximize', 'float', ...(PANELS[panel.id] && !PANELS[panel.id].fixed ? ['close'] : []), 'separator',
          { label: 'Reset the layout', action: () => this.reset() },
        ],
      });
      this.api.onDidRemovePanel(p => { if (!this.clearing && this.onRemove) this.onRemove(p.id); });
      this.api.onDidLayoutChange(() => { clearTimeout(this.timer); this.timer = setTimeout(() => this.store(), 300); });
      if (!this.restore()) this.defaults();
    }

    add(id, position, size) {
      const p = PANELS[id];
      const panel = this.api.addPanel({
        id, component: 'panel', title: p.title, ...(p.fixed ? { tabComponent: 'fixed' } : {}), ...(position ? { position } : {}),
      });
      if (size) panel.group.api.setSize(size);
      return panel;
    }

    /** The map in the middle; on the left the layers over the tool options, on the right the 3D preview over the
     *  properties. */
    defaults() {
      const H = this.api.height || 800;
      this.add('map');
      this.add('layers', { referencePanel: 'map', direction: 'left' });
      this.add('tool', { referencePanel: 'layers', direction: 'below' });
      this.add('props', { referencePanel: 'map', direction: 'right' });
      this.add('view3d', { referencePanel: 'props', direction: 'above' });
      const ui = ME.UI_SCALE || 1; // the sizes of the interface (js/view.js)
      this.api.getPanel('layers').group.api.setSize({ width: Math.round(290 * ui) });
      this.api.getPanel('props').group.api.setSize({ width: Math.round(380 * ui) });
      this.api.getPanel('layers').group.api.setSize({ height: Math.round(H * 0.68) });
      this.api.getPanel('view3d').group.api.setSize({ height: Math.round(H * 0.36) });
      this.api.getPanel('map').api.setActive();
    }

    store() {
      try { localStorage.setItem(this.key, JSON.stringify(this.api.toJSON())); } catch (err) { /* full or blocked */ }
    }

    restore() {
      let json = null;
      try { json = JSON.parse(localStorage.getItem(this.key) || 'null'); } catch (err) { json = null; }
      if (!json) return false;
      try {
        this.api.fromJSON(json);
        if (Object.entries(PANELS).some(([id, p]) => p.fixed && !this.api.getPanel(id))) throw new Error('a panel is missing');
        return true;
      } catch (err) {
        console.warn('dock layout', err);
        this.clearing = true;
        this.api.clear();
        this.clearing = false;
        return false;
      }
    }

    /** Back to the layout of the first start (with the 3D preview). */
    reset() {
      this.api.clear(); // onRemove() closes the optional panels
      localStorage.removeItem(this.key);
      this.defaults();
      this.onReset?.();
    }

    isOpen(id) { return !!this.api.getPanel(id); }

    /** Open a panel (the 3D preview: over the properties, else under the map), or bring it to the front. */
    show(id) {
      const panel = this.api.getPanel(id);
      if (panel) { panel.api.setActive(); return panel; }
      const props = this.api.getPanel('props');
      if (props && props.group.api.location.type === 'grid') {
        return this.add(id, { referencePanel: 'props', direction: 'above' }, { height: Math.round(props.group.api.height * 0.5) });
      }
      const map = this.api.getPanel('map'), h = map ? map.group.api.height : 600;
      return this.add(id, { referencePanel: 'map', direction: 'below' }, { height: Math.round(h * 0.48) });
    }

    close(id) {
      const panel = this.api.getPanel(id);
      if (panel) this.api.removePanel(panel);
    }

    toggleMaximize(id) {
      const panel = this.api.getPanel(id);
      if (!panel) return;
      if (panel.api.isMaximized()) panel.api.exitMaximized();
      else panel.api.maximize();
    }
  }

  ME.Dock = Dock;
})(window.ME = window.ME || {});

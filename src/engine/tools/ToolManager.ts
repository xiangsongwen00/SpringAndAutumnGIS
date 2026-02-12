import toolboxShellCss from './layout/ToolboxShell.css?raw';
import toolboxShellHtml from './layout/ToolboxShell.html?raw';
import { builtinToolModules } from './items';
import type {
  BuiltinToolId,
  ToolModule,
  ToolPanelOptions,
  ToolPanelPlacement,
  ToolPanelStyle,
  ToolTriggerContext
} from './types';

type PanelRecord = {
  element: HTMLElement;
  managed: boolean;
};

export type ToolManagerOptions = {
  root?: HTMLElement;
  mountBuiltinTools?: boolean;
};

const DEFAULT_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace';

const DEFAULT_STYLE: Required<ToolPanelStyle> = {
  textColor: '#60a5fa',
  backgroundColor: 'rgba(0, 0, 0, 0.62)',
  borderColor: 'rgba(59, 130, 246, 0.55)',
  fontFamily: DEFAULT_FONT,
  fontSizePx: 12,
  lineHeight: 1.45,
  padding: '8px 10px',
  borderRadiusPx: 6,
  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.3)',
  maxWidth: '60vw',
  whiteSpace: 'pre',
  zIndex: 20,
  pointerEvents: 'none',
  userSelect: 'none'
};

const TOOLBAR_PANEL_ID = 'toolbox-iconbar-panel';
const POPUP_PANEL_ID = 'toolbox-popup-panel';
const TOOL_POPUP_HTML = `
<div class="sag-tool-popup-head">
  <div class="sag-tool-popup-title" data-role="title"></div>
  <button class="sag-tool-popup-close" type="button" data-role="close">x</button>
</div>
<div class="sag-tool-popup-body" data-role="content"></div>
`;

export class ToolManager {
  private readonly _root: HTMLElement;
  private readonly _panels = new Map<string, PanelRecord>();
  private readonly _toolModules = new Map<BuiltinToolId, ToolModule>();
  private readonly _toolStyles = new Map<string, HTMLStyleElement>();
  private readonly _toolButtons = new Map<BuiltinToolId, HTMLButtonElement>();
  private readonly _toolStates = new Map<BuiltinToolId, boolean>();

  private _toolbarIconsEl: HTMLElement | null = null;
  private _popupTitleEl: HTMLElement | null = null;
  private _popupContentEl: HTMLElement | null = null;
  private _popupCloseEl: HTMLButtonElement | null = null;
  private _activePopupToolId: BuiltinToolId | null = null;
  private _activeToolCleanup: (() => void) | null = null;

  constructor(options?: ToolManagerOptions) {
    this._root = options?.root ?? document.body;
    this.registerTools(builtinToolModules);
    if (options?.mountBuiltinTools !== false) {
      this.mountBuiltinTools();
    }
  }

  registerTools(tools: readonly ToolModule[]): void {
    for (const tool of tools) {
      this._toolModules.set(tool.id, tool);
      if (!this._toolStates.has(tool.id)) {
        this._toolStates.set(tool.id, false);
      }
    }
    this.renderToolIcons();
  }

  mountBuiltinTools(options?: { toolbarPlacement?: ToolPanelPlacement; popupPlacement?: ToolPanelPlacement }): void {
    if (!this.getPanel(TOOLBAR_PANEL_ID)) {
      const toolbar = this.createPanel(TOOLBAR_PANEL_ID, {
        className: 'sag-toolbox',
        placement: options?.toolbarPlacement ?? { left: '50%', bottom: '50px' },
        style: {
          maxWidth: 'none',
          whiteSpace: 'normal',
          pointerEvents: 'auto',
          userSelect: 'auto',
          zIndex: 26,
          backgroundColor: 'transparent',
          borderColor: 'transparent',
          boxShadow: 'none',
          padding: '0'
        },
        visible: true
      });
      toolbar.style.transform = 'translateX(-50%)';
      this.ensureStyle('sag-toolbox-shell', toolboxShellCss);
      toolbar.innerHTML = toolboxShellHtml;
      this._toolbarIconsEl = toolbar.querySelector('[data-role="iconbar"]') as HTMLElement | null;
    }

    if (!this.getPanel(POPUP_PANEL_ID)) {
      const popup = this.createPanel(POPUP_PANEL_ID, {
        className: 'sag-tool-popup',
        placement: options?.popupPlacement ?? { right: '12px', top: '120px' },
        style: {
          maxWidth: '360px',
          whiteSpace: 'normal',
          pointerEvents: 'auto',
          userSelect: 'auto',
          zIndex: 26
        },
        visible: false
      });
      popup.innerHTML = TOOL_POPUP_HTML;
      this._popupTitleEl = popup.querySelector('[data-role="title"]') as HTMLElement | null;
      this._popupContentEl = popup.querySelector('[data-role="content"]') as HTMLElement | null;
      this._popupCloseEl = popup.querySelector('[data-role="close"]') as HTMLButtonElement | null;
      this._popupCloseEl?.addEventListener('click', () => this.closeToolPopup());
    }

    this.renderToolIcons();
    this.closeToolPopup();
  }

  activateTool(id: BuiltinToolId): void {
    this.onToolIconClick(id);
  }

  createPanel(id: string, options?: ToolPanelOptions): HTMLElement {
    this.assertMissing(id);

    const element = document.createElement('div');
    if (options?.className) {
      element.className = options.className;
    }
    this.applyPlacement(element, options?.placement);
    this.applyStyle(element, options?.style);
    element.style.display = options?.visible === false ? 'none' : '';

    this._root.appendChild(element);
    this._panels.set(id, { element, managed: true });
    return element;
  }

  attachPanel(id: string, element: HTMLElement, options?: ToolPanelOptions): HTMLElement {
    this.assertMissing(id);

    if (options?.className) {
      element.className = options.className;
    }
    this.applyPlacement(element, options?.placement);
    this.applyStyle(element, options?.style);
    element.style.display = options?.visible === false ? 'none' : '';

    this._panels.set(id, { element, managed: false });
    return element;
  }

  getPanel(id: string): HTMLElement | null {
    return this._panels.get(id)?.element ?? null;
  }

  setPanelText(id: string, text: string): void {
    const panel = this.requirePanel(id);
    panel.textContent = text;
  }

  setPanelLines(id: string, lines: readonly string[]): void {
    this.setPanelText(id, lines.join('\n'));
  }

  setPanelVisible(id: string, visible: boolean): void {
    const panel = this.requirePanel(id);
    panel.style.display = visible ? '' : 'none';
  }

  setPanelStyle(id: string, style: ToolPanelStyle): void {
    const panel = this.requirePanel(id);
    this.applyStyle(panel, style);
  }

  setPanelTextColor(id: string, color: string): void {
    const panel = this.requirePanel(id);
    panel.style.color = color;
  }

  removePanel(id: string): void {
    const record = this._panels.get(id);
    if (!record) return;

    if (record.managed) {
      if (record.element.parentElement) {
        record.element.parentElement.removeChild(record.element);
      }
    } else {
      record.element.textContent = '';
      record.element.style.display = 'none';
    }

    if (id === TOOLBAR_PANEL_ID) {
      this._toolbarIconsEl = null;
      this._toolButtons.clear();
    }

    if (id === POPUP_PANEL_ID) {
      this._popupTitleEl = null;
      this._popupContentEl = null;
      this._popupCloseEl = null;
      this._activePopupToolId = null;
      if (this._activeToolCleanup) {
        this._activeToolCleanup();
        this._activeToolCleanup = null;
      }
    }

    this._panels.delete(id);
  }

  dispose(): void {
    this.closeToolPopup();

    const ids = [...this._panels.keys()];
    for (const id of ids) {
      this.removePanel(id);
    }
    this._panels.clear();

    for (const styleEl of this._toolStyles.values()) {
      if (styleEl.parentElement) {
        styleEl.parentElement.removeChild(styleEl);
      }
    }
    this._toolStyles.clear();
  }

  private onToolIconClick(id: BuiltinToolId): void {
    const module = this._toolModules.get(id);
    const button = this._toolButtons.get(id);
    if (!module || !button) return;

    if (!module.hasPanel) {
      const currentActive = this._toolStates.get(id) ?? false;
      const setActive = (active: boolean) => {
        this._toolStates.set(id, active);
        this.syncToolIconStates();
      };

      if (module.onTrigger) {
        const context: ToolTriggerContext = {
          root: this._root,
          button,
          isActive: currentActive,
          setActive
        };
        module.onTrigger(context);
      } else {
        setActive(!currentActive);
      }

      this.closeToolPopup();
      return;
    }

    if (this._activePopupToolId === id && this.isToolPopupVisible()) {
      this.closeToolPopup();
      return;
    }

    this.openToolPopup(module);
  }

  private openToolPopup(module: ToolModule): void {
    const popup = this.getPanel(POPUP_PANEL_ID);
    if (!popup || !this._popupTitleEl || !this._popupContentEl) return;

    if (this._activeToolCleanup) {
      this._activeToolCleanup();
      this._activeToolCleanup = null;
    }

    if (module.panelCss) {
      this.ensureStyle(`sag-tool-${module.id}`, module.panelCss);
    }

    this._popupTitleEl.textContent = module.label;
    this._popupContentEl.innerHTML = module.panelHtml ?? '';
    this._activePopupToolId = module.id;
    this.setPanelVisible(POPUP_PANEL_ID, true);

    const cleanup = module.onMount?.(this._popupContentEl);
    this._activeToolCleanup = typeof cleanup === 'function' ? cleanup : null;
    this.syncToolIconStates();
  }

  private closeToolPopup(): void {
    if (this._activeToolCleanup) {
      this._activeToolCleanup();
      this._activeToolCleanup = null;
    }

    if (this.getPanel(POPUP_PANEL_ID)) {
      this.setPanelVisible(POPUP_PANEL_ID, false);
    }

    if (this._popupTitleEl) this._popupTitleEl.textContent = '';
    if (this._popupContentEl) this._popupContentEl.innerHTML = '';
    this._activePopupToolId = null;
    this.syncToolIconStates();
  }

  private isToolPopupVisible(): boolean {
    const popup = this.getPanel(POPUP_PANEL_ID);
    if (!popup) return false;
    return popup.style.display !== 'none';
  }

  private renderToolIcons(): void {
    if (!this._toolbarIconsEl) return;

    this._toolbarIconsEl.innerHTML = '';
    this._toolButtons.clear();

    const tools = [...this._toolModules.values()].sort((a, b) => a.order - b.order);
    for (const tool of tools) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sag-tool-icon-button';
      button.title = tool.label;
      button.setAttribute('aria-label', tool.label);
      button.dataset.toolId = tool.id;

      const icon = document.createElement('img');
      icon.className = 'sag-tool-icon';
      icon.src = tool.iconUrl;
      icon.alt = tool.label;
      button.appendChild(icon);

      button.addEventListener('click', () => this.onToolIconClick(tool.id));
      this._toolbarIconsEl.appendChild(button);
      this._toolButtons.set(tool.id, button);
    }

    this.syncToolIconStates();
  }

  private syncToolIconStates(): void {
    for (const [toolId, button] of this._toolButtons.entries()) {
      const tool = this._toolModules.get(toolId);
      if (!tool) continue;

      if (tool.hasPanel) {
        button.classList.toggle('is-active', toolId === this._activePopupToolId);
      } else {
        button.classList.toggle('is-active', this._toolStates.get(toolId) === true);
      }
    }
  }

  private ensureStyle(styleId: string, cssText: string): void {
    const existing = this._toolStyles.get(styleId);
    if (existing) return;

    const style = document.createElement('style');
    style.dataset.styleId = styleId;
    style.textContent = cssText;
    document.head.appendChild(style);
    this._toolStyles.set(styleId, style);
  }

  private requirePanel(id: string): HTMLElement {
    const panel = this._panels.get(id)?.element;
    if (!panel) {
      throw new Error(`Tool panel "${id}" not found.`);
    }
    return panel;
  }

  private assertMissing(id: string): void {
    if (this._panels.has(id)) {
      throw new Error(`Tool panel "${id}" already exists.`);
    }
  }

  private applyPlacement(element: HTMLElement, placement?: ToolPanelPlacement): void {
    element.style.position = 'absolute';
    element.style.top = placement?.top ?? '';
    element.style.right = placement?.right ?? '';
    element.style.bottom = placement?.bottom ?? '';
    element.style.left = placement?.left ?? '';
  }

  private applyStyle(element: HTMLElement, style?: ToolPanelStyle): void {
    const merged: Required<ToolPanelStyle> = {
      ...DEFAULT_STYLE,
      ...(style ?? {})
    };
    element.style.color = merged.textColor;
    element.style.background = merged.backgroundColor;
    element.style.border = `1px solid ${merged.borderColor}`;
    element.style.fontFamily = merged.fontFamily;
    element.style.fontSize = `${merged.fontSizePx}px`;
    element.style.lineHeight = String(merged.lineHeight);
    element.style.padding = merged.padding;
    element.style.borderRadius = `${merged.borderRadiusPx}px`;
    element.style.boxShadow = merged.boxShadow;
    element.style.maxWidth = merged.maxWidth;
    element.style.whiteSpace = merged.whiteSpace;
    element.style.zIndex = String(merged.zIndex);
    element.style.pointerEvents = merged.pointerEvents;
    element.style.userSelect = merged.userSelect;
  }
}

export type {
  BuiltinToolId,
  ToolModule,
  ToolPanelOptions,
  ToolPanelPlacement,
  ToolPanelStyle,
  ToolTriggerContext
} from './types';

export type ToolPanelPlacement = {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
};

export type ToolPanelStyle = {
  textColor?: string;
  backgroundColor?: string;
  borderColor?: string;
  fontFamily?: string;
  fontSizePx?: number;
  lineHeight?: number;
  padding?: string;
  borderRadiusPx?: number;
  boxShadow?: string;
  maxWidth?: string;
  whiteSpace?: 'normal' | 'pre' | 'pre-wrap';
  zIndex?: number;
  pointerEvents?: string;
  userSelect?: string;
};

export type ToolPanelOptions = {
  className?: string;
  placement?: ToolPanelPlacement;
  style?: ToolPanelStyle;
  visible?: boolean;
};

export type BuiltinToolId =
  | 'debug-tools'
  | 'terrain-toggle'
  | 'axis-info'
  | 'survey-tools'
  | 'marker-animation-tools';

export type ToolTriggerContext = {
  root: HTMLElement;
  button: HTMLButtonElement;
  isActive: boolean;
  setActive: (active: boolean) => void;
};

export type ToolModule = {
  id: BuiltinToolId;
  label: string;
  order: number;
  iconUrl: string;
  hasPanel: boolean;
  panelHtml?: string;
  panelCss?: string;
  onMount?: (root: HTMLElement) => void | (() => void);
  onTrigger?: (context: ToolTriggerContext) => void;
};

import panelHtml from './DebugTool.html?raw';
import panelCss from './DebugTool.css?raw';
import debugIcon from '../../../../assets/img/toolIcons/debug.svg';
import type { ToolModule } from '../../types';

export const debugToolModule: ToolModule = {
  id: 'debug-tools',
  label: 'Debug',
  order: 0,
  iconUrl: debugIcon,
  hasPanel: true,
  panelHtml,
  panelCss
};

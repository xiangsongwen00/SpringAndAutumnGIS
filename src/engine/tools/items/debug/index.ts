import panelHtml from './DebugTool.html?raw';
import panelCss from './DebugTool.css?raw';
import { createIconDataUrl } from '../icon';
import type { ToolModule } from '../../types';

export const debugToolModule: ToolModule = {
  id: 'debug-tools',
  label: 'Debug',
  order: 0,
  iconUrl: createIconDataUrl('DB', '#1d4ed8'),
  hasPanel: true,
  panelHtml,
  panelCss
};

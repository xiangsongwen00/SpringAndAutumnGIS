import panelHtml from './AxisInfoTool.html?raw';
import panelCss from './AxisInfoTool.css?raw';
import { createIconDataUrl } from '../icon';
import type { ToolModule } from '../../types';

export const axisInfoToolModule: ToolModule = {
  id: 'axis-info',
  label: 'Axis',
  order: 2,
  iconUrl: createIconDataUrl('AX', '#4338ca'),
  hasPanel: true,
  panelHtml,
  panelCss
};

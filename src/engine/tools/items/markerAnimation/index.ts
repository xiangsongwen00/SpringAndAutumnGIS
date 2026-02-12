import panelHtml from './MarkerAnimationTool.html?raw';
import panelCss from './MarkerAnimationTool.css?raw';
import { createIconDataUrl } from '../icon';
import type { ToolModule } from '../../types';

export const markerAnimationToolModule: ToolModule = {
  id: 'marker-animation-tools',
  label: 'Marker',
  order: 4,
  iconUrl: createIconDataUrl('MK', '#be185d'),
  hasPanel: true,
  panelHtml,
  panelCss
};

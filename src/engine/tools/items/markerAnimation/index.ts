import panelHtml from './MarkerAnimationTool.html?raw';
import panelCss from './MarkerAnimationTool.css?raw';
import markerIcon from '../../../../assets/img/toolIcons/marker.svg';
import type { ToolModule } from '../../types';

export const markerAnimationToolModule: ToolModule = {
  id: 'marker-animation-tools',
  label: 'Marker',
  order: 4,
  iconUrl: markerIcon,
  hasPanel: true,
  panelHtml,
  panelCss
};

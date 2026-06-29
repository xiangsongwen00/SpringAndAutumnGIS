import panelHtml from './AxisInfoTool.html?raw';
import panelCss from './AxisInfoTool.css?raw';
import axisIcon from '../../../../assets/img/toolIcons/axis.svg';
import type { ToolModule } from '../../types';

export const axisInfoToolModule: ToolModule = {
  id: 'axis-info',
  label: 'Axis',
  order: 2,
  iconUrl: axisIcon,
  hasPanel: true,
  panelHtml,
  panelCss
};

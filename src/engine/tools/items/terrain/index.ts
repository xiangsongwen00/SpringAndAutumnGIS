import panelHtml from './TerrainTool.html?raw';
import panelCss from './TerrainTool.css?raw';
import { createIconDataUrl } from '../icon';
import type { ToolModule } from '../../types';

export const terrainToolModule: ToolModule = {
  id: 'terrain-toggle',
  label: 'Terrain',
  order: 1,
  iconUrl: createIconDataUrl('TR', '#0f766e'),
  hasPanel: false,
  onTrigger: ({ isActive, setActive }) => {
    setActive(!isActive);
  },
  panelHtml,
  panelCss
};

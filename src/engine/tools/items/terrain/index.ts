import panelHtml from './TerrainTool.html?raw';
import panelCss from './TerrainTool.css?raw';
import terrainIcon from '../../../../assets/img/toolIcons/terrain.svg';
import type { ToolModule } from '../../types';

export const terrainToolModule: ToolModule = {
  id: 'terrain-toggle',
  label: 'Terrain',
  order: 1,
  iconUrl: terrainIcon,
  hasPanel: false,
  onTrigger: ({ root, setActive }) => {
    const enabled = true;
    setActive(true);
    root.dispatchEvent(
      new CustomEvent('sag:terrain-toggle', {
        detail: { enabled }
      })
    );
  },
  panelHtml,
  panelCss
};

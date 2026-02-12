import panelHtml from './SurveyTool.html?raw';
import panelCss from './SurveyTool.css?raw';
import { createIconDataUrl } from '../icon';
import type { ToolModule } from '../../types';

export const surveyToolModule: ToolModule = {
  id: 'survey-tools',
  label: 'Survey',
  order: 3,
  iconUrl: createIconDataUrl('SV', '#92400e'),
  hasPanel: true,
  panelHtml,
  panelCss
};

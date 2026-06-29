import panelHtml from './SurveyTool.html?raw';
import panelCss from './SurveyTool.css?raw';
import surveyIcon from '../../../../assets/img/toolIcons/survey.svg';
import type { ToolModule } from '../../types';

export const surveyToolModule: ToolModule = {
  id: 'survey-tools',
  label: 'Survey',
  order: 3,
  iconUrl: surveyIcon,
  hasPanel: true,
  panelHtml,
  panelCss
};

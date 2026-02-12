import { axisInfoToolModule } from './axis';
import { debugToolModule } from './debug';
import { markerAnimationToolModule } from './markerAnimation';
import { surveyToolModule } from './survey';
import { terrainToolModule } from './terrain';
import type { ToolModule } from '../types';

export const builtinToolModules: readonly ToolModule[] = [
  debugToolModule,
  terrainToolModule,
  axisInfoToolModule,
  surveyToolModule,
  markerAnimationToolModule
];

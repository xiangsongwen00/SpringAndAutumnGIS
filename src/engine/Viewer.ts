import { Engine, type EngineOptions } from './Engine';

export type ViewerOptions = EngineOptions;

export class Viewer extends Engine {
  constructor(options: ViewerOptions) {
    super(options);
  }
}

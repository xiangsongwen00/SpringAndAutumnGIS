import {
  DEFAULT_VIEW_STATE,
  heightToZoom,
  mergeViewState,
  normalizeViewState,
  type BaseView,
  type ViewContext,
  type ViewMode,
  type ViewState,
  type ViewStateInput,
  zoomToHeight
} from './BaseView';
import { GlobeView3D } from './GlobeView3D';
import { MapView2D } from './MapView2D';

export type ViewChangeEvent = {
  previousMode: ViewMode;
  mode: ViewMode;
  previousState: ViewState;
  state: ViewState;
};

export type ViewChangeHandler = (event: ViewChangeEvent) => void;

export class ViewManager {
  readonly globeView: GlobeView3D;
  readonly mapView: MapView2D;

  private _mode: ViewMode;
  private _state: ViewState;
  private readonly _handlers = new Set<ViewChangeHandler>();
  private readonly _views = new Map<ViewMode, BaseView>();

  constructor(options: { context: ViewContext; mode?: ViewMode; state?: ViewStateInput }) {
    this._mode = options.mode ?? '3d';
    this._state = normalizeViewState(options.state ?? DEFAULT_VIEW_STATE);
    this.globeView = new GlobeView3D(options.context);
    this.mapView = new MapView2D(options.context);
    this._views.set(this.globeView.mode, this.globeView);
    this._views.set(this.mapView.mode, this.mapView);
    this.activateCurrentView();
  }

  get mode(): ViewMode {
    return this._mode;
  }

  get state(): ViewState {
    return { ...this._state };
  }

  setViewState(patch: ViewStateInput): ViewState {
    const previousMode = this._mode;
    const previousState = this._state;
    this._state = mergeViewState(this._state, patch);
    this.activeView.applyViewState(this._state);
    this.emit(previousMode, previousState);
    return this.state;
  }

  setMode(mode: ViewMode, patch?: ViewStateInput): ViewState {
    if (mode !== '2d' && mode !== '3d') {
      throw new Error(`Unsupported view mode: ${String(mode)}`);
    }

    const previousMode = this._mode;
    const previousState = this._state;
    const base = this.convertStateForMode(previousState, mode);
    this._mode = mode;
    this._state = normalizeViewState({
      ...base,
      ...(patch ?? {})
    });
    this.activateCurrentView(previousMode);
    this.emit(previousMode, previousState);
    return this.state;
  }

  update(dtSeconds: number, timeSeconds: number): void {
    this.activeView.update(dtSeconds, timeSeconds);
  }

  dispose(): void {
    for (const view of this._views.values()) {
      view.dispose();
    }
    this._views.clear();
    this._handlers.clear();
  }

  onChange(handler: ViewChangeHandler): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }

  private get activeView(): BaseView {
    const view = this._views.get(this._mode);
    if (!view) {
      throw new Error(`View is not registered: ${this._mode}`);
    }
    return view;
  }

  private activateCurrentView(previousMode?: ViewMode): void {
    if (previousMode && previousMode !== this._mode) {
      this._views.get(previousMode)?.deactivate();
    }

    for (const [mode, view] of this._views) {
      if (mode !== this._mode) {
        view.deactivate();
      }
    }

    this.activeView.activate(this._state);
  }

  private convertStateForMode(state: ViewState, mode: ViewMode): ViewState {
    if (mode === '2d') {
      return normalizeViewState({
        ...state,
        zoom: state.zoom > 0 ? state.zoom : heightToZoom(state.height),
        pitch: 0,
        roll: 0
      });
    }

    return normalizeViewState({
      ...state,
      height: state.height > 0 ? state.height : zoomToHeight(state.zoom),
      pitch: state.pitch === 0 ? -45 : state.pitch
    });
  }

  private emit(previousMode: ViewMode, previousState: ViewState): void {
    const event: ViewChangeEvent = {
      previousMode,
      mode: this._mode,
      previousState: { ...previousState },
      state: this.state
    };

    for (const handler of this._handlers) {
      handler(event);
    }
  }
}

import * as THREE from 'three';

export type PlanarLodGridLevel = {
  stepMultiplier: number;
  halfCells: number;
  color: number;
  opacity: number;
};

export type PlanarLodGridOptions = {
  levels?: readonly PlanarLodGridLevel[];
  baseSteps?: readonly number[];
  heightBreakpoints?: readonly number[];
};

export type PlanarLodGridDebugInfo = {
  baseStep: number;
  cameraHeight: number;
  focusX: number;
  focusY: number;
  activeSteps: number[];
};

const DEFAULT_LEVELS: readonly PlanarLodGridLevel[] = [
  { stepMultiplier: 1, halfCells: 10, color: 0x7dd3fc, opacity: 0.72 },
  { stepMultiplier: 4, halfCells: 10, color: 0x22c55e, opacity: 0.6 },
  { stepMultiplier: 16, halfCells: 10, color: 0xf59e0b, opacity: 0.5 }
];

const DEFAULT_BASE_STEPS: readonly number[] = [50, 100, 250, 500, 1000, 2000, 4000];
const DEFAULT_HEIGHT_BREAKPOINTS: readonly number[] = [400, 900, 2000, 4500, 10000, 22000];

export class PlanarLodGrid {
  private readonly _root = new THREE.Group();
  private readonly _levels: readonly PlanarLodGridLevel[];
  private readonly _baseSteps: readonly number[];
  private readonly _heightBreakpoints: readonly number[];

  private _lines: THREE.LineSegments[] = [];
  private _stateKey = '';
  private _debugInfo: PlanarLodGridDebugInfo = {
    baseStep: DEFAULT_BASE_STEPS[0] ?? 50,
    cameraHeight: 0,
    focusX: 0,
    focusY: 0,
    activeSteps: []
  };

  constructor(options?: PlanarLodGridOptions) {
    const levels = options?.levels ?? DEFAULT_LEVELS;
    const baseSteps = options?.baseSteps ?? DEFAULT_BASE_STEPS;
    const heightBreakpoints = options?.heightBreakpoints ?? DEFAULT_HEIGHT_BREAKPOINTS;

    if (levels.length === 0) {
      throw new Error('PlanarLodGrid requires at least one level.');
    }
    if (baseSteps.length === 0) {
      throw new Error('PlanarLodGrid requires at least one base step.');
    }
    if (heightBreakpoints.length !== baseSteps.length - 1) {
      throw new Error('heightBreakpoints length must equal baseSteps length - 1.');
    }

    for (const level of levels) {
      if (!Number.isFinite(level.stepMultiplier) || level.stepMultiplier <= 0) {
        throw new Error(`Invalid level.stepMultiplier: ${level.stepMultiplier}`);
      }
      if (!Number.isInteger(level.halfCells) || level.halfCells <= 0) {
        throw new Error(`Invalid level.halfCells: ${level.halfCells}`);
      }
      if (!Number.isFinite(level.opacity) || level.opacity < 0 || level.opacity > 1) {
        throw new Error(`Invalid level.opacity: ${level.opacity}`);
      }
    }

    for (const step of baseSteps) {
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`Invalid base step: ${step}`);
      }
    }

    for (const value of heightBreakpoints) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid height breakpoint: ${value}`);
      }
    }

    this._levels = levels;
    this._baseSteps = baseSteps;
    this._heightBreakpoints = heightBreakpoints;
  }

  get object3d(): THREE.Object3D {
    return this._root;
  }

  get debugInfo(): PlanarLodGridDebugInfo {
    return {
      baseStep: this._debugInfo.baseStep,
      cameraHeight: this._debugInfo.cameraHeight,
      focusX: this._debugInfo.focusX,
      focusY: this._debugInfo.focusY,
      activeSteps: [...this._debugInfo.activeSteps]
    };
  }

  update(focusX: number, focusY: number, cameraHeight: number): void {
    const safeHeight = Number.isFinite(cameraHeight) ? Math.max(0, cameraHeight) : 0;
    const baseStep = this.pickBaseStep(safeHeight);

    const states = this._levels.map((level) => {
      const step = baseStep * level.stepMultiplier;
      return {
        level,
        step,
        centerX: Math.round(focusX / step) * step,
        centerY: Math.round(focusY / step) * step
      };
    });

    const stateKey =
      `${baseStep}|` +
      states
        .map((state) => `${state.step}:${state.centerX.toFixed(3)},${state.centerY.toFixed(3)}`)
        .join('|');

    if (stateKey === this._stateKey) {
      this._debugInfo = {
        baseStep,
        cameraHeight: safeHeight,
        focusX,
        focusY,
        activeSteps: states.map((state) => state.step)
      };
      return;
    }

    this._stateKey = stateKey;
    this.disposeLines();

    const nextLines: THREE.LineSegments[] = [];
    for (let i = 0; i < states.length; i += 1) {
      const state = states[i];
      if (!state) continue;
      const line = this.createLevelLines(state.centerX, state.centerY, state.step, state.level, i);
      nextLines.push(line);
      this._root.add(line);
    }
    this._lines = nextLines;

    this._debugInfo = {
      baseStep,
      cameraHeight: safeHeight,
      focusX,
      focusY,
      activeSteps: states.map((state) => state.step)
    };
  }

  dispose(): void {
    this.disposeLines();
    this._stateKey = '';
  }

  private pickBaseStep(cameraHeight: number): number {
    for (let i = 0; i < this._heightBreakpoints.length; i += 1) {
      const breakpoint = this._heightBreakpoints[i];
      const step = this._baseSteps[i];
      if (breakpoint === undefined || step === undefined) continue;
      if (cameraHeight < breakpoint) {
        return step;
      }
    }
    const fallback = this._baseSteps[this._baseSteps.length - 1];
    if (fallback === undefined) {
      throw new Error('PlanarLodGrid base steps are empty.');
    }
    return fallback;
  }

  private createLevelLines(
    centerX: number,
    centerY: number,
    step: number,
    level: PlanarLodGridLevel,
    levelIndex: number
  ): THREE.LineSegments {
    const lineCountPerAxis = level.halfCells * 2 + 1;
    const segmentCount = lineCountPerAxis * 2;
    const positions = new Float32Array(segmentCount * 2 * 3);

    const halfExtent = level.halfCells * step;
    let cursor = 0;

    for (let i = -level.halfCells; i <= level.halfCells; i += 1) {
      const offset = i * step;

      const x = centerX + offset;
      positions[cursor++] = x;
      positions[cursor++] = centerY - halfExtent;
      positions[cursor++] = 0;
      positions[cursor++] = x;
      positions[cursor++] = centerY + halfExtent;
      positions[cursor++] = 0;

      const y = centerY + offset;
      positions[cursor++] = centerX - halfExtent;
      positions[cursor++] = y;
      positions[cursor++] = 0;
      positions[cursor++] = centerX + halfExtent;
      positions[cursor++] = y;
      positions[cursor++] = 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: level.color,
      transparent: true,
      opacity: level.opacity,
      depthWrite: false,
      depthTest: false
    });

    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = 10 + levelIndex;
    return lines;
  }

  private disposeLines(): void {
    for (const line of this._lines) {
      this._root.remove(line);
      line.geometry.dispose();
      if (Array.isArray(line.material)) {
        for (const material of line.material) {
          material.dispose();
        }
      } else {
        line.material.dispose();
      }
    }
    this._lines = [];
  }
}

import type { MapStyleCapabilityIssue, MapStyleCapabilityReport } from './MapStyleLoader';
import type { MapStyle } from './VectorStyleTypes';

/** GPU surface support, deliberately separate from the Canvas analyzer. */
export function analyzeVectorSurfaceStyle(style: MapStyle): MapStyleCapabilityReport {
  const issues: MapStyleCapabilityIssue[] = [];
  let supportedLayers = 0, degradedLayers = 0, unsupportedLayers = 0;
  const supported = new Set(['background', 'fill', 'line', 'circle']);
  const unsupportedProperties = new Set(['fill-pattern', 'line-pattern', 'background-pattern']);
  const degradedProperties = new Set(['fill-translate', 'line-translate', 'circle-translate',
    'line-offset', 'line-gap-width', 'line-blur', 'line-gradient',
    'circle-stroke-color', 'circle-stroke-width', 'circle-stroke-opacity', 'circle-blur']);
  for (const layer of style.layers) {
    const layerIssues: MapStyleCapabilityIssue[] = [];
    if (!supported.has(layer.type)) layerIssues.push({ layerId: layer.id, severity: 'unsupported',
      message: `${layer.type} 尚未接入 GPU 地表通道${layer.type === 'symbol' ? '，等待独立 SymbolPass' : ''}。` });
    for (const property of Object.keys(layer.paint ?? {})) {
      if (unsupportedProperties.has(property)) layerIssues.push({ layerId: layer.id, severity: 'unsupported',
        message: `${property} 尚未实现；跳过本样式层，禁止默认黑色替代。` });
      else if (degradedProperties.has(property)) layerIssues.push({ layerId: layer.id, severity: 'degraded',
        message: `${property} 尚未实现，保留基础几何/颜色。` });
    }
    if (layer.type === 'line' && (layer.layout?.['line-join'] !== undefined ||
        layer.layout?.['line-cap'] !== undefined)) layerIssues.push({ layerId: layer.id, severity: 'degraded',
      message: '目前仅有分段 butt stroke，完整 join/cap 待实现。' });
    issues.push(...layerIssues);
    if (layerIssues.some((issue) => issue.severity === 'unsupported')) unsupportedLayers++;
    else if (layerIssues.length) degradedLayers++;
    else supportedLayers++;
  }
  return { supportedLayers, degradedLayers, unsupportedLayers, issues };
}

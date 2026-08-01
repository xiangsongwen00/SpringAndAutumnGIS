/** Shared by every globe vertex shader. Heights and camera coordinates are metres. */
export const globeCoordinateShader = /* glsl */ `
uniform vec2 sag_ellipsoidRadii;
uniform float sag_heightOffset;

vec3 sag_geodeticRelativeToEye(vec2 lonLatRadians, float heightMeters) {
  float a = sag_ellipsoidRadii.x;
  float b = sag_ellipsoidRadii.y;
  float eccentricitySquared = 1.0 - (b * b) / (a * a);
  float sinLatitude = sin(lonLatRadians.y);
  float cosLatitude = cos(lonLatRadians.y);
  float n = 1.0 / sqrt(1.0 - eccentricitySquared * sinLatitude * sinLatitude);
  float normalizedHeight = (heightMeters + sag_heightOffset) / a;
  vec3 worldNormalized = vec3(
    (n + normalizedHeight) * cosLatitude * sin(lonLatRadians.x),
    (n * (1.0 - eccentricitySquared) + normalizedHeight) * sinLatitude,
    (n + normalizedHeight) * cosLatitude * cos(lonLatRadians.x)
  );
  return (worldNormalized - cameraPosition / a) * a;
}

vec4 sag_projectGeodetic(vec2 lonLatRadians, float heightMeters) {
  vec3 relativeToEye = sag_geodeticRelativeToEye(lonLatRadians, heightMeters);
  return projectionMatrix * vec4(mat3(viewMatrix) * relativeToEye, 1.0);
}
`;


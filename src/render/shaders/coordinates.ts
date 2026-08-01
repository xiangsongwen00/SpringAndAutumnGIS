/** Shared by every globe vertex shader. Heights and camera coordinates are metres. */
export const globeCoordinateShader = /* glsl */ `
uniform vec2 sag_ellipsoidRadii;
uniform float sag_heightOffset;
uniform vec3 sag_cameraHigh;
uniform vec3 sag_cameraLow;

vec4 sag_projectLocalToEye(
  vec3 localWorldMeters,
  vec3 originHigh,
  vec3 originLow
) {
  vec3 relativeToEye =
    (originHigh - sag_cameraHigh) +
    (originLow - sag_cameraLow) +
    localWorldMeters;
  return projectionMatrix * vec4(mat3(viewMatrix) * relativeToEye, 1.0);
}

vec3 sag_geodeticTrigRelativeToEye(
  vec2 longitudeSinCos,
  vec2 latitudeSinCos,
  float heightMeters
) {
  float a = sag_ellipsoidRadii.x;
  float b = sag_ellipsoidRadii.y;
  float eccentricitySquared = 1.0 - (b * b) / (a * a);
  float sinLatitude = latitudeSinCos.x;
  float cosLatitude = latitudeSinCos.y;
  float n = 1.0 / sqrt(1.0 - eccentricitySquared * sinLatitude * sinLatitude);
  float normalizedHeight = (heightMeters + sag_heightOffset) / a;
  vec3 worldNormalized = vec3(
    (n + normalizedHeight) * cosLatitude * longitudeSinCos.x,
    (n * (1.0 - eccentricitySquared) + normalizedHeight) * sinLatitude,
    (n + normalizedHeight) * cosLatitude * longitudeSinCos.y
  );
  return (worldNormalized - cameraPosition / a) * a;
}

vec3 sag_geodeticRelativeToEye(vec2 lonLatRadians, float heightMeters) {
  return sag_geodeticTrigRelativeToEye(
    vec2(sin(lonLatRadians.x), cos(lonLatRadians.x)),
    vec2(sin(lonLatRadians.y), cos(lonLatRadians.y)),
    heightMeters
  );
}

vec4 sag_projectGeodeticTrig(
  vec2 longitudeSinCos,
  vec2 latitudeSinCos,
  float heightMeters
) {
  vec3 relativeToEye = sag_geodeticTrigRelativeToEye(
    longitudeSinCos,
    latitudeSinCos,
    heightMeters
  );
  return projectionMatrix * vec4(mat3(viewMatrix) * relativeToEye, 1.0);
}

vec4 sag_projectGeodetic(vec2 lonLatRadians, float heightMeters) {
  vec3 relativeToEye = sag_geodeticRelativeToEye(lonLatRadians, heightMeters);
  return projectionMatrix * vec4(mat3(viewMatrix) * relativeToEye, 1.0);
}
`;

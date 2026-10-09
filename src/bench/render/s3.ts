import { darkInk } from '../../core/palette.ts';
import { LINES_MIN_PX, SYMBOL_FONT, SYMBOL_MIN_PX } from './types.ts';
import type { Camera, RendererFactory } from './types.ts';

const GLYPH_PX = 64;

const VERT = `#version 300 es
void main() {
  // One triangle covering the viewport.
  gl_Position = vec4(vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0), 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uGrid;    // one texel per cell: palette index
uniform sampler2D uPalette;  // rgb per index, alpha = 1 when the symbol ink is dark
uniform sampler2D uAtlas;    // symbol coverage, one tile per palette index
uniform vec2 uOrigin;
uniform float uScale;
uniform vec2 uGridSize;
uniform float uViewHeight;
uniform float uAtlasCols;
out vec4 color;
void main() {
  vec2 g = uOrigin + vec2(gl_FragCoord.x, uViewHeight - gl_FragCoord.y) / uScale;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= uGridSize.x || g.y >= uGridSize.y) {
    color = vec4(vec3(0.533), 1.0);
    return;
  }
  uint index = texelFetch(uGrid, ivec2(g), 0).r;
  vec4 entry = texelFetch(uPalette, ivec2(int(index), 0), 0);
  vec3 c = entry.rgb;
  vec2 f = fract(g);
  if (uScale >= ${SYMBOL_MIN_PX}.0 && index != 0u) {
    float cols = uAtlasCols;
    vec2 tile = vec2(float(index % uint(cols)), float(index / uint(cols)));
    // Explicit gradients: fract() is discontinuous at cell edges and would pick the wrong mip.
    float a = textureGrad(uAtlas, (tile + f) / cols, dFdx(g) / cols, dFdy(g) / cols).r;
    c = mix(c, vec3(1.0 - entry.a), a);
  }
  if (uScale >= ${LINES_MIN_PX}.0) {
    vec2 d = min(f, 1.0 - f) * uScale;
    vec2 f10 = fract(g / 10.0);
    vec2 d10 = min(f10, 1.0 - f10) * 10.0 * uScale;
    if (min(d10.x, d10.y) < 0.75) c = mix(c, vec3(0.0), 0.8);
    else if (min(d.x, d.y) < 0.5) c = mix(c, vec3(0.0), 0.25);
  }
  color = vec4(c, 1.0);
}`;

/**
 * S3 WebGL2: the grid is an R16UI texture (one texel per cell) and a single full-screen
 * fragment shader resolves colour, grid lines and symbols (from a glyph atlas) per pixel.
 * Cost depends on the number of screen pixels, not on the number of cells.
 */
export const createS3: RendererFactory = (canvas, grid, palette) => {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' })!;
  const { width, height, cells } = grid;

  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERT],
    [gl.FRAGMENT_SHADER, FRAG],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const texture = (unit: number, filter: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  // Unit 0: grid.
  texture(0, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, cells);

  // Unit 1: palette.
  const n = palette.size + 1;
  const pal = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    pal.set(palette.rgb.subarray(i * 3, i * 3 + 3), i * 4);
    pal[i * 4 + 3] = darkInk(palette, i) ? 255 : 0;
  }
  texture(1, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pal);

  // Unit 2: symbol atlas, rasterized once with canvas 2D.
  const cols = Math.ceil(Math.sqrt(n));
  const atlasPx = cols * GLYPH_PX;
  const atlas = new OffscreenCanvas(atlasPx, atlasPx);
  const actx = atlas.getContext('2d', { willReadFrequently: true })!;
  actx.font = `${GLYPH_PX * 0.7}px ${SYMBOL_FONT}`;
  actx.textAlign = 'center';
  actx.textBaseline = 'middle';
  actx.fillStyle = '#fff';
  for (let i = 1; i < n; i++) {
    actx.fillText(palette.entries[i].symbol, ((i % cols) + 0.5) * GLYPH_PX, (Math.floor(i / cols) + 0.5) * GLYPH_PX);
  }
  const rgba = actx.getImageData(0, 0, atlasPx, atlasPx).data;
  const coverage = new Uint8Array(atlasPx * atlasPx);
  for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4 + 3];
  texture(2, gl.LINEAR_MIPMAP_LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlasPx, atlasPx, 0, gl.RED, gl.UNSIGNED_BYTE, coverage);
  gl.generateMipmap(gl.TEXTURE_2D);

  const u = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(u('uGrid'), 0);
  gl.uniform1i(u('uPalette'), 1);
  gl.uniform1i(u('uAtlas'), 2);
  gl.uniform2f(u('uGridSize'), width, height);
  gl.uniform1f(u('uViewHeight'), canvas.height);
  gl.uniform1f(u('uAtlasCols'), cols);
  const uOrigin = u('uOrigin');
  const uScale = u('uScale');
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0);

  const render = (cam: Camera) => {
    gl.uniform2f(uOrigin, cam.x, cam.y);
    gl.uniform1f(uScale, cam.scale);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return {
    render,
    cellChanged(index) {
      const x = index % width;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, (index - x) / width, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, cells, index);
    },
    flush: render,
    gridChanged() {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, cells);
    },
    // Grid texture + palette texture + atlas with its mip chain.
    layerBytes: () => width * height * 2 + n * 4 + Math.round((atlasPx * atlasPx * 4) / 3),
  };
};

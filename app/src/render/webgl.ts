import type { Grid } from '../core/grid.ts';
import type { Backstitch } from '../edit/editor.ts';
import { darkInk } from '../core/palette.ts';
import type { Palette } from '../core/palette.ts';
import type { Camera } from '../view/camera.ts';

/** Grid lines are drawn from this cell size (device pixels) up, symbols from SYMBOL_MIN_PX up. */
const LINES_MIN_PX = 4;
const SYMBOL_MIN_PX = 12;
const GLYPH_PX = 64;
/** Half thickness of a half / quarter stitch strand, as a share of the cell (measured across the diagonal, x1.41). */
const STRAND = '0.12';
const SYMBOL_FONT = '"Segoe UI Symbol", "DejaVu Sans", sans-serif';

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
uniform vec3 uBackground;
uniform sampler2D uMask;     // one texel per cell: > 0 when the cell is selected
uniform bool uHasSelection;
uniform usampler2D uQuarters; // per cell: palette index of the quarter stitch in each corner (TL, TR, BL, BR)
uniform usampler2D uHalves;   // per cell: palette index of the "/" and of the "\\" half stitch
uniform bool uFractions;      // there are half / quarter stitches and their layer is shown
uniform bool uShowFull;
out vec4 color;

vec3 thread(uint index) {
  return texelFetch(uPalette, ivec2(int(index), 0), 0).rgb;
}

bool selected(ivec2 cell) {
  if (cell.x < 0 || cell.y < 0 || cell.x >= int(uGridSize.x) || cell.y >= int(uGridSize.y)) return false;
  return texelFetch(uMask, cell, 0).r > 0.0;
}

void main() {
  vec2 g = uOrigin + vec2(gl_FragCoord.x, uViewHeight - gl_FragCoord.y) / uScale;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= uGridSize.x || g.y >= uGridSize.y) {
    color = vec4(uBackground, 1.0);
    return;
  }
  uint index = uShowFull ? texelFetch(uGrid, ivec2(g), 0).r : 0u;
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
  if (uFractions) {
    // Drawn as the thread itself, so whatever is underneath stays visible: a half stitch is a
    // strand from corner to corner, a quarter stitch a strand from its corner to the centre.
    float slash = abs(f.x + f.y - 1.0);     // distance (x1.41) to the "/" diagonal
    float backslash = abs(f.x - f.y);       // ... and to the other one
    float strand = max(${STRAND}, 1.0 / uScale);
    float rim = uScale >= 8.0 ? 1.5 / uScale : 0.0; // dark edge, so a strand reads on its own colour
    uvec4 q = texelFetch(uQuarters, ivec2(g), 0);
    bool top = f.y < 0.5;
    bool left = f.x < 0.5;
    uint corner = top ? (left ? q.r : q.g) : (left ? q.b : q.a);
    float toCorner = top == left ? backslash : slash;
    uvec2 h = texelFetch(uHalves, ivec2(g), 0).rg;
    // Rims first, then the strands on top of them.
    if ((corner != 0u && toCorner < strand + rim) || (h.r != 0u && slash < strand + rim) || (h.g != 0u && backslash < strand + rim)) {
      c = mix(c, vec3(0.0), 0.6);
    }
    if (corner != 0u && toCorner < strand) c = thread(corner);
    if (h.r != 0u && slash < strand) c = thread(h.r);
    if (h.g != 0u && backslash < strand) c = thread(h.g);
  }
  if (uScale >= ${LINES_MIN_PX}.0) {
    vec2 d = min(f, 1.0 - f) * uScale;
    vec2 f10 = fract(g / 10.0);
    vec2 d10 = min(f10, 1.0 - f10) * 10.0 * uScale;
    if (min(d10.x, d10.y) < 0.75) c = mix(c, vec3(0.0), 0.8);
    else if (min(d.x, d.y) < 0.5) c = mix(c, vec3(0.0), 0.25);
  }
  if (uHasSelection) {
    ivec2 cell = ivec2(g);
    bool inside = selected(cell);
    // Cells outside the selection are dimmed; its outline is a dashed black and white line.
    if (!inside) c = mix(c, vec3(0.3), 0.5);
    if (uScale >= 3.0) {
      vec2 edge = min(f, 1.0 - f) * uScale;
      bool across = edge.x < 1.0 && selected(cell + ivec2(f.x < 0.5 ? -1 : 1, 0)) != inside;
      bool along = edge.y < 1.0 && selected(cell + ivec2(0, f.y < 0.5 ? -1 : 1)) != inside;
      if (across || along) c = vec3(mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 4.0), 2.0));
    }
  }
  color = vec4(c, 1.0);
}`;

// Backstitch: one quad per line, drawn over the grid. Each vertex knows both ends of its line.
const LINE_VERT = `#version 300 es
in vec4 aLine;   // both ends, in cells
in vec2 aCorner; // x: 0 at the first end, 1 at the second; y: -1 / 1 for the two sides
in vec3 aColor;
uniform vec2 uOrigin;
uniform float uScale;
uniform vec2 uView;
uniform float uGrow;    // extra width in pixels (the dark outline is the same line, wider)
uniform float uOutline; // 1 = draw black instead of the thread colour
out vec3 vColor;
void main() {
  vec2 a = (aLine.xy - uOrigin) * uScale;
  vec2 b = (aLine.zw - uOrigin) * uScale;
  vec2 along = normalize(b - a);
  float w = max(2.0, uScale * 0.16) + uGrow;
  vec2 p = mix(a, b, aCorner.x) + along * (aCorner.x * 2.0 - 1.0) * w * 0.5 + vec2(-along.y, along.x) * aCorner.y * w * 0.5;
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
  vColor = aColor * (1.0 - uOutline);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 color;
void main() {
  color = vec4(vColor, 1.0);
}`;

const LINE_FLOATS = 9;
/** French knots: half the length of the dash, in cells, and how many times fatter than a line it is. */
const KNOT_REACH = 0.1;
const KNOT_FAT = 2.2;
const CORNERS = [0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1];

export interface GridRenderer {
  /** Draw a frame. `dpr` converts the camera's CSS pixels to canvas pixels. */
  render(cam: Camera, dpr: number): void;
  /** One cell of the grid changed (grid.cells is already updated). */
  cellChanged(index: number): void;
  /** Many cells changed: send the whole grid again. */
  gridChanged(): void;
  /** Show this selection (one byte per cell), or none. */
  selectionChanged(mask: Uint8Array | null): void;
  /** Half / quarter stitches of these cells changed. null = send them all (first time, or many). */
  fractionsChanged(quarters: Uint16Array, halves: Uint16Array, changed: number[] | null): void;
  /** The backstitch lines to draw, plus the one being dragged out, if any. */
  backstitchChanged(lines: readonly Backstitch[], preview: Backstitch | null): void;
  /** Which layers to draw. */
  setVisible(full: boolean, fractional: boolean, backstitch: boolean): void;
  /** The canvas backing store changed size. */
  resize(): void;
  dispose(): void;
}

/**
 * WebGL2 renderer: the grid is an R16UI texture (one texel per cell) and a single full-screen
 * fragment shader resolves colour, grid lines and symbols (from a glyph atlas) per pixel.
 * `background` is the colour around the chart. Returns null when WebGL2 is not available.
 */
export function createGridRenderer(
  canvas: HTMLCanvasElement,
  grid: Grid,
  palette: Palette,
  background: [number, number, number],
): GridRenderer | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const { width, height, cells } = grid;

  const build = (vertex: string, fragment: string) => {
    const made = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
      gl.attachShader(made, shader);
      gl.deleteShader(shader); // freed with the program
    }
    gl.linkProgram(made);
    if (!gl.getProgramParameter(made, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(made) ?? 'link');
    return made;
  };

  // The grid program stays current between frames, so its uniforms can be set at any time.
  const program = build(VERT, FRAG);
  gl.useProgram(program);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const textures: WebGLTexture[] = [];
  const texture = (unit: number, filter: number) => {
    const t = gl.createTexture()!;
    textures.push(t);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
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

  // Unit 3: selection mask, filled in when there is a selection.
  texture(3, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);

  // Units 4 and 5: quarter and half stitches. One empty texel until the chart has any.
  texture(4, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, 1, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(4));
  texture(5, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16UI, 1, 1, 0, gl.RG_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(2));
  let hasFractions = false;
  const visible = { full: true, fractional: true, backstitch: true };

  // Backstitch lines.
  const lineProgram = build(LINE_VERT, LINE_FRAG);
  const lineVao = gl.createVertexArray();
  const lineBuffer = gl.createBuffer();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
  [
    ['aLine', 4, 0],
    ['aCorner', 2, 4],
    ['aColor', 3, 6],
  ].forEach(([name, size, offset]) => {
    const at = gl.getAttribLocation(lineProgram, name as string);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size as number, gl.FLOAT, false, LINE_FLOATS * 4, (offset as number) * 4);
  });
  gl.bindVertexArray(vao);
  const lu = (name: string) => gl.getUniformLocation(lineProgram, name);
  const lineUniforms = { origin: lu('uOrigin'), scale: lu('uScale'), view: lu('uView'), grow: lu('uGrow'), outline: lu('uOutline') };
  let lineVertices = 0;

  const u = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(u('uGrid'), 0);
  gl.uniform1i(u('uPalette'), 1);
  gl.uniform1i(u('uAtlas'), 2);
  gl.uniform1i(u('uMask'), 3);
  gl.uniform1i(u('uQuarters'), 4);
  gl.uniform1i(u('uHalves'), 5);
  const uHasSelection = u('uHasSelection');
  const uFractions = u('uFractions');
  const uShowFull = u('uShowFull');
  gl.uniform1i(uShowFull, 1);
  gl.uniform2f(u('uGridSize'), width, height);
  gl.uniform1f(u('uAtlasCols'), cols);
  gl.uniform3f(u('uBackground'), ...background);
  const uOrigin = u('uOrigin');
  const uScale = u('uScale');
  const uViewHeight = u('uViewHeight');

  const resize = () => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1f(uViewHeight, canvas.height);
  };
  resize();

  return {
    render(cam, dpr) {
      gl.uniform2f(uOrigin, cam.x, cam.y);
      gl.uniform1f(uScale, cam.scale * dpr);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (lineVertices === 0 || !visible.backstitch) return;
      gl.useProgram(lineProgram);
      gl.bindVertexArray(lineVao);
      gl.uniform2f(lineUniforms.origin, cam.x, cam.y);
      gl.uniform1f(lineUniforms.scale, cam.scale * dpr);
      gl.uniform2f(lineUniforms.view, canvas.width, canvas.height);
      // A dark outline first, so a line reads on any stitch colour.
      for (const [grow, outline] of [
        [2, 1],
        [0, 0],
      ]) {
        gl.uniform1f(lineUniforms.grow, grow);
        gl.uniform1f(lineUniforms.outline, outline);
        gl.drawArrays(gl.TRIANGLES, 0, lineVertices);
      }
      gl.useProgram(program);
      gl.bindVertexArray(vao);
    },
    fractionsChanged(quarters, halves, changed) {
      const formats = [
        [4, quarters, gl.RGBA16UI, gl.RGBA_INTEGER, 4],
        [5, halves, gl.RG16UI, gl.RG_INTEGER, 2],
      ] as const;
      for (const [unit, data, internal, format, per] of formats) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        if (!hasFractions || changed === null) {
          gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.UNSIGNED_SHORT, data);
        } else {
          for (const cell of changed) {
            const x = cell % width;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x, (cell - x) / width, 1, 1, format, gl.UNSIGNED_SHORT, data, cell * per);
          }
        }
      }
      hasFractions = true;
      gl.uniform1i(uFractions, visible.fractional ? 1 : 0);
    },
    backstitchChanged(lines, preview) {
      const all = preview ? [...lines, preview] : lines;
      const data = new Float32Array(all.length * 6 * LINE_FLOATS);
      all.forEach((l, k) => {
        for (let v = 0; v < 6; v++) {
          const o = (k * 6 + v) * LINE_FLOATS;
          // A line of no length is a French knot: drawn as a short, fat dash, which reads as a dot.
          const knot = l.x0 === l.x1 && l.y0 === l.y1;
          const reach = knot ? KNOT_REACH : 0;
          data.set([l.x0 / 2 - reach, l.y0 / 2, l.x1 / 2 + reach, l.y1 / 2, CORNERS[v * 2], CORNERS[v * 2 + 1] * (knot ? KNOT_FAT : 1)], o);
          data.set([palette.rgb[l.color * 3] / 255, palette.rgb[l.color * 3 + 1] / 255, palette.rgb[l.color * 3 + 2] / 255], o + 6);
        }
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      lineVertices = all.length * 6;
    },
    setVisible(full, fractional, backstitch) {
      Object.assign(visible, { full, fractional, backstitch });
      gl.uniform1i(uShowFull, full ? 1 : 0);
      gl.uniform1i(uFractions, hasFractions && fractional ? 1 : 0);
    },
    cellChanged(index) {
      const x = index % width;
      gl.activeTexture(gl.TEXTURE0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, (index - x) / width, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, cells, index);
    },
    gridChanged() {
      gl.activeTexture(gl.TEXTURE0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, cells);
    },
    selectionChanged(mask) {
      gl.uniform1i(uHasSelection, mask ? 1 : 0);
      if (!mask) return;
      // The shader only needs "zero or not", so the 0 / 1 bytes go up as they are.
      gl.activeTexture(gl.TEXTURE3);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, mask);
    },
    resize,
    dispose() {
      for (const t of textures) gl.deleteTexture(t);
      gl.deleteProgram(program);
      gl.deleteProgram(lineProgram);
      gl.deleteBuffer(lineBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteVertexArray(lineVao);
    },
  };
}

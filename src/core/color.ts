const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const fLab = (t: number) => (t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037037 * t + 16 / 116);

/** sRGB (0-255 integers) -> CIE Lab (D65), written to out[o..o+2]. */
export function srgbToLab(r: number, g: number, b: number, out: Float32Array | Float64Array | number[], o = 0): void {
  const lr = LINEAR[r];
  const lg = LINEAR[g];
  const lb = LINEAR[b];
  const fx = fLab((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const fy = fLab(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const fz = fLab((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

const PI = Math.PI;
const TAU = 2 * PI;
const POW25_7 = 6103515625;

/** CIEDE2000 colour difference (kL = kC = kH = 1). */
export function ciede2000(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Cb * Cb * Cb * Cb * Cb * Cb * Cb;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + POW25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  let h1p = C1p === 0 ? 0 : Math.atan2(b1, a1p);
  if (h1p < 0) h1p += TAU;
  let h2p = C2p === 0 ? 0 : Math.atan2(b2, a2p);
  if (h2p < 0) h2p += TAU;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const chroma = C1p * C2p !== 0;
  let dhp = 0;
  if (chroma) {
    dhp = h2p - h1p;
    if (dhp > PI) dhp -= TAU;
    else if (dhp < -PI) dhp += TAU;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (chroma) {
    if (Math.abs(h1p - h2p) > PI) hbp += hbp < TAU ? TAU : -TAU;
    hbp /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos(hbp - PI / 6) +
    0.24 * Math.cos(2 * hbp) +
    0.32 * Math.cos(3 * hbp + PI / 30) -
    0.2 * Math.cos(4 * hbp - (63 * PI) / 180);
  const hd = ((hbp * 180) / PI - 275) / 25;
  const dTheta = (PI / 6) * Math.exp(-hd * hd);
  const Cbp7 = Cbp * Cbp * Cbp * Cbp * Cbp * Cbp * Cbp;
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + POW25_7));
  const l50 = (Lbp - 50) * (Lbp - 50);
  const Sl = 1 + (0.015 * l50) / Math.sqrt(20 + l50);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta) * Rc;
  const tl = dLp / Sl;
  const tc = dCp / Sc;
  const th = dHp / Sh;
  return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
}

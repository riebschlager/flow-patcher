// Borrowed from Flow's palettes.js. Ours to change; see docs/decisions/0001.
import type { Dye } from '../fluid/fluid';

export type RGB = [number, number, number];

export interface PaletteColor {
  name: string;
  hex: string;
  /** The canonical dye this slot is injected as; renderers map it to `hex`. */
  rgb: Dye;
}

export interface Palette {
  id: string;
  name: string;
  description: string;
  colors: PaletteColor[];
}

// Dye is injected in one fixed basis, so changing palette recolors existing fluid.
export const canonicalDyes: readonly Dye[] = [
  [0.5, 0.2, 1],
  [0.1, 0.86, 0.67],
  [1, 0.19, 0.26],
  [1, 0.57, 0.12],
];

type Definition = [id: string, name: string, description: string, slots: [string, string][]];

const definitions: Definition[] = [
  ['classic', 'Original glow', 'The familiar lilac, sea glass, coral and amber.', [['Lilac', '#b7a0ff'], ['Sea glass', '#73e2d0'], ['Coral', '#ff9e9e'], ['Amber', '#edca82']]],
  ['aurora', 'Aurora', 'Luminous glacial colors, drifting into pink and jade.', [['Orchid', '#c89bff'], ['Glacier', '#70e8ff'], ['Pink', '#ff87c8'], ['Jade', '#81f4bd']]],
  ['desert', 'Desert dusk', 'Dusty plum, quiet sage and sun-warmed earth.', [['Plum', '#a69bd8'], ['Sage', '#a6c7b0'], ['Terracotta', '#f18f76'], ['Sand', '#efd4a2']]],
  ['tide', 'Tidal blue', 'A cool wash of periwinkle, aqua and seafoam.', [['Periwinkle', '#879fe8'], ['Aqua', '#62d9dc'], ['Deep blue', '#5b92d5'], ['Seafoam', '#c1ebd8']]],
  ['ember', 'Ember', 'Wine and bronze meet glowing vermilion and apricot.', [['Wine', '#c27699'], ['Bronze', '#d1a263'], ['Vermilion', '#ff8763'], ['Apricot', '#ffd18b']]],
  ['garden', 'Botanical', 'Soft iris and rose among fresh mint and lime.', [['Iris', '#ae9bd5'], ['Mint', '#7fd0aa'], ['Rose', '#e4a7ae'], ['Lime', '#c4d685']]],
  ['afterglow', 'Afterglow', 'Electric violet, cyan and magenta with a lemon spark.', [['Violet', '#b187ff'], ['Cyan', '#5cddff'], ['Magenta', '#ff6bad'], ['Lemon', '#edee85']]],
  ['porcelain', 'Porcelain', 'Muted lavender, celadon, blush and warm cream.', [['Lavender', '#c5bedc'], ['Celadon', '#b8d8d3'], ['Blush', '#e4c5c5'], ['Cream', '#e9dbbc']]],
];

export const hexRGB = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;

export const colorPalettes: Readonly<Record<string, Palette>> = Object.fromEntries(
  definitions.map(([id, name, description, slots]) => [
    id,
    { id, name, description, colors: slots.map(([name, hex], i) => ({ name, hex, rgb: canonicalDyes[i] as Dye })) },
  ]),
);

export const normalizePalette = (id: unknown): string =>
  typeof id === 'string' && Object.hasOwn(colorPalettes, id) ? id : 'classic';

export const getPalette = (id: unknown): Palette => colorPalettes[normalizePalette(id)] as Palette;

type Matrix = RGB[];

function inverse(columns: readonly Dye[]): Matrix {
  const [[a, d, g], [b, e, h], [c, f, i]] = columns as [Dye, Dye, Dye];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const adjugate: Matrix = [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ];
  return adjugate.map((row) => row.map((v) => v / det) as RGB);
}

const triangles = [[0, 1, 3], [0, 3, 2]];
const bases = triangles.map((indices) => inverse(indices.map((i) => canonicalDyes[i] as Dye)));
const dot = (row: RGB, r: number, g: number, b: number): number => row[0] * r + row[1] * g + row[2] * b;

export type DyeMapper = (r: number, g: number, b: number, out: number[]) => number[];

/** Maps canonical dye to the palette's linear-light colors. */
export function createDyeMapper(id: unknown): DyeMapper {
  const palette = getPalette(id);
  if (palette.id === 'classic') {
    return (r, g, b, out) => {
      out[0] = r;
      out[1] = g;
      out[2] = b;
      return out;
    };
  }
  const dyes = palette.colors.map((c) => hexRGB(c.hex).map((v) => v ** 2.2));
  const transforms: Matrix[] = triangles.map((indices, t) =>
    [0, 1, 2].map((channel) =>
      [0, 1, 2].map((column) =>
        indices.reduce((sum, i, j) => sum + (dyes[i] as number[])[channel] * (bases[t] as Matrix)[j][column], 0),
      ),
    ) as Matrix,
  );
  const [first] = bases as [Matrix];
  return (r, g, b, out) => {
    const inFirst =
      dot(first[0], r, g, b) >= -1e-7 && dot(first[1], r, g, b) >= -1e-7 && dot(first[2], r, g, b) >= -1e-7;
    const matrix = (inFirst ? transforms[0] : transforms[1]) as Matrix;
    out[0] = Math.max(0, dot(matrix[0], r, g, b));
    out[1] = Math.max(0, dot(matrix[1], r, g, b));
    out[2] = Math.max(0, dot(matrix[2], r, g, b));
    return out;
  };
}

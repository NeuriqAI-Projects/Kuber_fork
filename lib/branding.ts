// App branding: product identity (name/logo/copy) + color theme + light/dark
// mode. Every surface — page background, sidebar, cards, inputs, borders — is
// generated from a hue + mode pair, so each color has both a dark and a light
// variant (dark base + light accent shade in dark mode; light base + the same
// accent shade in light mode).

export const APP_NAME = "Kuber";
export const APP_LOGO_INITIAL = "K";

/** Fired on `window` when the brand logo is uploaded or removed, with the new
 *  signed URL (or null) as `detail` — lets the app shell's sidebar update
 *  without a page reload. */
export const BRAND_LOGO_CHANGED = "brand-logo-changed";
export const APP_TITLE = "Kuber Admin";
export const APP_DESCRIPTION = "Kuber demo admin workspace";
export const APP_TAGLINE = "Access the lead command center.";

export type ThemeId = "monochrome" | "blue" | "green" | "purple" | "orange" | "rose";
export type ThemeMode = "dark" | "light";

export const CSS_VARS = [
  "--background", "--foreground",
  "--card", "--card-foreground",
  "--popover", "--popover-foreground",
  "--primary", "--primary-foreground",
  "--secondary", "--secondary-foreground",
  "--muted", "--muted-foreground",
  "--accent", "--accent-foreground",
  "--border", "--input", "--ring", "--field",
  "--sidebar", "--hover",
] as const;

type CssVar = (typeof CSS_VARS)[number];
type Palette = Record<CssVar, string>;

interface ColorDefinition {
  id: ThemeId;
  label: string;
  /** Hex color used for the swatch dot in the theme picker UI. */
  swatch: string;
  /** Hue in degrees, or null for the grayscale monochrome theme. */
  hue: number | null;
  accentSat: number;
  accentLight: number;
}

export const COLORS: ColorDefinition[] = [
  { id: "monochrome", label: "Monochrome",    swatch: "#fafafa", hue: null, accentSat: 0,  accentLight: 98 },
  { id: "blue",       label: "Ocean Blue",     swatch: "#3b82f6", hue: 217,  accentSat: 91, accentLight: 60 },
  { id: "green",      label: "Forest Green",   swatch: "#22c55e", hue: 142,  accentSat: 71, accentLight: 45 },
  { id: "purple",     label: "Royal Purple",   swatch: "#a855f7", hue: 271,  accentSat: 81, accentLight: 65 },
  { id: "orange",     label: "Sunset Orange",  swatch: "#f97316", hue: 25,   accentSat: 95, accentLight: 53 },
  { id: "rose",       label: "Rose",           swatch: "#f43f5e", hue: 350,  accentSat: 89, accentLight: 60 },
];

// Attio-style ladders. Neutrals use a cool gray (hue 220) in every theme so
// surfaces read the same whichever accent is picked; only --primary/--ring
// carry the theme's hue. Light mode: white page, panels, popovers and fields,
// separated by 1px borders; a faint off-white sidebar; hover/selected states
// are a light gray step (--hover). Dark mode mirrors it one step up from
// near-black. See the "Surface ladder" section in CLAUDE.md.
const NEUTRAL_HUE = 220;

/** Dark mode: near-black page, one step lighter panels/popovers, fields one
 *  step above the panel so they never vanish into it. */
function buildDarkPalette(c: ColorDefinition): Palette {
  const mono = c.hue === null;
  const n = NEUTRAL_HUE;
  const accent = mono ? "hsl(0 0% 96%)" : `hsl(${c.hue} ${c.accentSat}% ${c.accentLight}%)`;
  const fg = `hsl(${n} 10% 95%)`;
  return {
    "--background":           `hsl(${n} 7% 7%)`,
    "--sidebar":              `hsl(${n} 7% 8.5%)`,
    "--card":                 `hsl(${n} 7% 9%)`,
    "--popover":              `hsl(${n} 7% 11%)`,
    "--field":                `hsl(${n} 7% 11.5%)`,
    "--secondary":            `hsl(${n} 6% 13.5%)`,
    "--muted":                `hsl(${n} 6% 13.5%)`,
    "--accent":               `hsl(${n} 6% 15%)`,
    "--hover":                `hsl(${n} 6% 12.5%)`,
    "--foreground":           fg,
    "--card-foreground":      fg,
    "--popover-foreground":   fg,
    "--secondary-foreground": fg,
    "--accent-foreground":    fg,
    "--muted-foreground":     `hsl(${n} 6% 62%)`,
    "--border":               `hsl(${n} 6% 16.5%)`,
    "--input":                `hsl(${n} 6% 20%)`,
    "--primary":              accent,
    "--primary-foreground":   mono ? "hsl(0 0% 9%)" : "hsl(0 0% 100%)",
    "--ring":                 accent,
  };
}

/** Light mode (Attio): white everywhere content lives, an off-white sidebar,
 *  1px cool-gray borders, and near-black text. --secondary/--muted are the
 *  light gray used for chips, nested sections and skeletons; --hover is the
 *  row/menu hover. */
function buildLightPalette(c: ColorDefinition): Palette {
  const mono = c.hue === null;
  const n = NEUTRAL_HUE;
  const white = "hsl(0 0% 100%)";
  const fg = `hsl(${n} 9% 12%)`;
  const accent = mono ? fg : `hsl(${c.hue} ${c.accentSat}% ${Math.min(c.accentLight, 55)}%)`;
  return {
    "--background":           white,
    "--card":                 white,
    "--popover":              white,
    "--field":                white,
    "--sidebar":              `hsl(${n} 14% 98.5%)`,
    "--secondary":            `hsl(${n} 14% 96.5%)`,
    "--muted":                `hsl(${n} 14% 96.5%)`,
    "--accent":               `hsl(${n} 14% 95.5%)`,
    "--hover":                `hsl(${n} 14% 97.5%)`,
    "--foreground":           fg,
    "--card-foreground":      fg,
    "--popover-foreground":   fg,
    "--secondary-foreground": fg,
    "--accent-foreground":    fg,
    "--muted-foreground":     `hsl(${n} 5% 45%)`,
    "--border":               `hsl(${n} 13% 92%)`,
    "--input":                `hsl(${n} 11% 88%)`,
    "--primary":              accent,
    "--primary-foreground":   white,
    "--ring":                 accent,
  };
}

export const DEFAULT_THEME_ID: ThemeId = "monochrome";
export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return !!value && COLORS.some((c) => c.id === value);
}

export function isThemeMode(value: string | null | undefined): value is ThemeMode {
  return value === "dark" || value === "light";
}

function getColor(id: string | null | undefined): ColorDefinition {
  return COLORS.find((c) => c.id === id) ?? COLORS[0];
}

/** Every theme × mode palette, keyed "themeId:mode". app/layout.tsx embeds
 *  this as JSON in its pre-paint script so there's one source of truth. */
export function allPalettes(): Record<string, Palette> {
  const out: Record<string, Palette> = {};
  for (const c of COLORS) {
    out[`${c.id}:dark`] = buildDarkPalette(c);
    out[`${c.id}:light`] = buildLightPalette(c);
  }
  return out;
}

export function getPalette(id: string | null | undefined, mode: ThemeMode): Palette {
  const color = getColor(id);
  return mode === "light" ? buildLightPalette(color) : buildDarkPalette(color);
}

export const THEME_STORAGE_KEY = "kuber-theme";
export const THEME_MODE_STORAGE_KEY = "kuber-theme-mode";

/** Applies a theme + mode's CSS custom properties to the document root. Safe to call before mount. */
export function applyTheme(id: string | null | undefined, mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const palette = getPalette(id, mode);
  const root = document.documentElement;
  for (const cssVar of CSS_VARS) root.style.setProperty(cssVar, palette[cssVar]);
  root.dataset.theme = getColor(id).id;
  root.dataset.mode = mode;
}

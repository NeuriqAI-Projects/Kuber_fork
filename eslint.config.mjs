import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname
});

/**
 * UI rules that CLAUDE.md states and that nothing used to enforce.
 *
 * Every one of these was already written down, and every one was violated
 * anyway — 131 ad-hoc `bg-secondary/NN` fills, 42 dead focus rings — because a
 * document cannot fail a build. New code copies the code around it, so a rule
 * that only lives in prose decays to the average of the codebase.
 *
 * These run on screens and pages only. components/ui/** is exempt: that is
 * where the shared primitives are built, and the primitive is allowed to
 * contain the raw element it wraps.
 */
const surfaceChecks = [
    {
      selector: "Literal[value=/bg-(secondary|muted|accent|card|popover)\\/[0-9]/]",
      message:
        "Ad-hoc surface fill. Light mode renders page, card, secondary, muted and accent as ONE grey, so a partial-opacity version of any of them is invisible. Use a ladder token at full strength: bg-background (page), bg-card (panel), bg-secondary (nested section), bg-field (anything a user types into). See CLAUDE.md > Surface ladder.",
    },
    {
      selector: "TemplateElement[value.raw=/bg-(secondary|muted|accent|card|popover)\\/[0-9]/]",
      message:
        "Ad-hoc surface fill inside a template string. Use a ladder token at full strength — see CLAUDE.md > Surface ladder.",
    },
    {
      selector: "Literal[value=/\\bbg-white\\b/], TemplateElement[value.raw=/\\bbg-white\\b/]",
      message:
        "bg-white is not in the palette. White belongs to fields only, via bg-field — see CLAUDE.md > Light-mode color budget.",
    },
    {
      selector:
        "Literal[value=/(focus|focus-visible):(ring|outline)-/], TemplateElement[value.raw=/(focus|focus-visible):(ring|outline)-/]",
      message:
        "Dead class. app/globals.css kills every focus ring and outline with an !important reset, so this never renders. Removing it stops someone 'fixing' the reset to make it work. See CLAUDE.md > No focus ring at all.",
    },
];

/** Only these are exempt inside components/ui: a shared Input is allowed to
 *  contain the <input> it wraps. The surface rules above are not exempt
 *  anywhere — leaving them off components/ui was how 11 ad-hoc fills and a
 *  prompt editor rendering a field as a panel survived the first sweep. */
const rawElementChecks = [
    {
      selector: "JSXOpeningElement[name.name='input']",
      message:
        "Raw <input>. Use the shared Input from components/ui/input.tsx so the field fill, sizing and disabled state stay consistent. A hidden file picker or a bare a11y target under a custom control is the documented exception — add an eslint-disable-next-line with the reason. See CLAUDE.md > One shared component per control type.",
    },
    {
      selector: "JSXOpeningElement[name.name='textarea']",
      message:
        "Raw <textarea>. Use the shared Textarea from components/ui/textarea.tsx. See CLAUDE.md > One shared component per control type.",
    },
];

// Flat config: a later block REPLACES an earlier one's setting for the same
// rule, it does not merge with it. Listing the two sets separately would have
// silently switched the surface checks off for every app screen, so the block
// that needs both spells both out.
const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["components/ui/**/*.tsx"],
    rules: { "no-restricted-syntax": ["error", ...surfaceChecks] },
  },
  {
    files: ["app/**/*.tsx", "components/app/**/*.tsx"],
    rules: { "no-restricted-syntax": ["error", ...surfaceChecks, ...rawElementChecks] },
  },
];

export default eslintConfig;

// design-templates.js
// Shared registry of design templates for generated PDF/PPTX resource
// exports. A template bundles a color palette + font family — nothing
// else — because both builders hand-write their file format, and only
// PDF's standard-14 fonts (Helvetica/Times/Courier) and PPTX theme
// typefaces (a name PowerPoint substitutes at render time, no embedding
// required) can be swapped without shipping actual font files.
//
// SINGLE SOURCE OF TRUTH: resources-endpoint.js resolves + entitlement-
// checks a requested template id against this list before generation;
// pdf-builder.js and pptx-builder.js only ever receive an already-chosen
// template id and fall back to the default themselves if it's missing or
// unrecognized — they never perform entitlement checks. The frontend
// (resources.js) mirrors this list for the picker UI — keep both in sync
// when editing template ids, names, or tiers.

// PDF standard-14 font families. Each has a fixed regular/bold BaseFont
// pair (no embedding needed — every PDF reader ships these) and an
// approximate average-character-width factor used for line wrapping,
// since Courier is monospace-wide and Times is narrower than Helvetica.
export const PDF_FONT_FAMILIES = {
  helvetica: { regular: 'Helvetica', bold: 'Helvetica-Bold', widthFactor: 0.50, boldWidthFactor: 0.54 },
  times: { regular: 'Times-Roman', bold: 'Times-Bold', widthFactor: 0.44, boldWidthFactor: 0.48 },
  courier: { regular: 'Courier', bold: 'Courier-Bold', widthFactor: 0.60, boldWidthFactor: 0.60 },
};

export const DESIGN_TEMPLATES = [
  {
    id: 'classic',
    name: 'Classic',
    tier: 'free',
    description: "Cognita's signature green — clean and versatile.",
    colors: { accent: '3F6B5B', accentSoft: '8DB7A5', ink: '171717', muted: '8C8C86', rule: 'D9D9D6' },
    pdfFont: 'helvetica',
    pptxFont: 'Calibri',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    tier: 'plus',
    description: 'Navy and serif type for a formal, editorial feel.',
    colors: { accent: '2A3F5F', accentSoft: '7C93B8', ink: '14161C', muted: '6B7280', rule: 'D7DAE0' },
    pdfFont: 'times',
    pptxFont: 'Cambria',
  },
  {
    id: 'sunrise',
    name: 'Sunrise',
    tier: 'plus',
    description: 'Warm amber accents for an approachable, energetic tone.',
    colors: { accent: 'C1611D', accentSoft: 'E8A868', ink: '2B1B12', muted: '9C8577', rule: 'EAD9C8' },
    pdfFont: 'helvetica',
    pptxFont: 'Trebuchet MS',
  },
  {
    id: 'slate',
    name: 'Slate',
    tier: 'studio',
    description: 'Near-monochrome grayscale — quiet and minimal.',
    colors: { accent: '33383D', accentSoft: '8F969C', ink: '1A1C1E', muted: '7A7F84', rule: 'DADCDE' },
    pdfFont: 'helvetica',
    pptxFont: 'Arial',
  },
  {
    id: 'forest',
    name: 'Forest',
    tier: 'studio',
    description: 'Deep green and serif type for an organic, grounded feel.',
    colors: { accent: '234D35', accentSoft: '6FA37E', ink: '16231B', muted: '6C7B70', rule: 'D6E0D9' },
    pdfFont: 'times',
    pptxFont: 'Georgia',
  },
  {
    id: 'rose',
    name: 'Rose',
    tier: 'studio',
    description: 'Maroon and blush tones for a distinctive, refined look.',
    colors: { accent: '7A2E3A', accentSoft: 'C98A93', ink: '241417', muted: '8C7377', rule: 'E7D6D9' },
    pdfFont: 'times',
    pptxFont: 'Cambria',
  },
];

export const DEFAULT_TEMPLATE_ID = 'classic';

export function getTemplate(templateId) {
  return DESIGN_TEMPLATES.find((t) => t.id === templateId) || null;
}

export function getDefaultTemplate() {
  return getTemplate(DEFAULT_TEMPLATE_ID);
}

// Resolves a requested template id against what the plan is actually
// entitled to. Returns { ok: true, template } if the request is fine, or
// { ok: false, error, requiredTier } if it isn't — it never silently
// substitutes the default template for one the plan doesn't have access
// to, since that would mean generating something different from what
// was actually requested without telling the person.
//
// @param {string} planId
// @param {string} requestedTemplateId
// @param {(planId: string, requiredTier: string) => boolean} planSatisfies
export function resolveEntitledTemplate(planId, requestedTemplateId, planSatisfies) {
  if (!requestedTemplateId) {
    return { ok: true, template: getDefaultTemplate() };
  }

  const requested = getTemplate(requestedTemplateId);
  if (!requested) {
    return { ok: false, error: 'Unknown design template: ' + requestedTemplateId };
  }

  if (!planSatisfies(planId, requested.tier)) {
    const tierLabel = requested.tier === 'studio' ? 'Cognita Studio' : 'Cognita Plus';
    return {
      ok: false,
      error: 'The "' + requested.name + '" design is available on ' + tierLabel + ' and above.',
      requiredTier: requested.tier,
    };
  }

  return { ok: true, template: requested };
}

// PDF font-family lookup with a safe fallback to Helvetica.
export function getPdfFontFamily(templateId) {
  const template = getTemplate(templateId) || getDefaultTemplate();
  return PDF_FONT_FAMILIES[template.pdfFont] || PDF_FONT_FAMILIES.helvetica;
}

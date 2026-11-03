// ============================================================
// WEBGENCY — price list used by the server (must match the order form)
// If you change a price on the website, change it here too.
// ============================================================
const BASE = { std: 35, template: 75, custom: 155 };
const SECTION = 15;      // each paid section, each custom section
const LANGUAGE = 15;     // each extra language
const VERSION = 15;      // each extra version
const FREE_SECTIONS = 3; // Template and Custom
const EXTRAS = {
  'Envelope with Initials (Custom Envelope + Wax Seal)': 30,
  'Bespoke Opening Animation': 40,
  'Music: Song of Your Choice': 15,
  'Custom Illustration': 25,
  'Extra Custom Illustration': 25,
  'Custom Illustration (included free)': 0,
  'Custom AI Video': 40,
  'Custom Domain': 60,
  'Masterpiece Bundle (Custom Illustration + Custom AI Video)': 55,
  'Express Delivery': null // depends on the package
};
const EXPRESS = { std: 30, template: 30, custom: 50 };
const LINK_TIERS = [{ min: 1, r: 3 }, { min: 50, r: 2.5 }, { min: 100, r: 2 }, { min: 300, r: 1.5 }];

function linkRate(n) { let r = LINK_TIERS[0].r; LINK_TIERS.forEach(t => { if (n >= t.min) r = t.r; }); return r; }
function linkPrice(n) {
  if (!n || n <= 0) return 0;
  let p = Math.round(n * linkRate(n));
  LINK_TIERS.forEach(t => { if (t.min > n) { const c = Math.round(t.min * t.r); if (c < p) p = c; } });
  return p;
}
function packageOf(designType) {
  const d = String(designType || '');
  if (d.startsWith('Save the Date')) return 'std';
  if (d.startsWith('Custom Design')) return 'custom';
  if (d.startsWith('Template Design')) return 'template';
  return null;
}
const arr = v => (Array.isArray(v) ? v : []);
const int = v => { const n = parseInt(v, 10); return isNaN(n) || n < 0 ? 0 : n; };

// Returns { total } or { error } when the order contains something unknown.
function priceOrder(o) {
  const pkg = packageOf(o.designType);
  if (!pkg) return { error: 'Unknown package: ' + o.designType };
  let total = BASE[pkg];
  const sections = arr(o.sections);
  const custom = arr(o.customBlocks).filter(x => String(x).trim());
  if (pkg === 'std') total += sections.length * SECTION;            // every Save the Date section is +€15 (incl. "other")
  else total += Math.max(0, sections.length - FREE_SECTIONS) * SECTION + custom.length * SECTION;
  total += arr(o.extraLangs).length * LANGUAGE;
  for (const name of arr(o.extras)) {
    if (!(name in EXTRAS)) return { error: 'Unknown extra: ' + name };
    total += name === 'Express Delivery' ? EXPRESS[pkg] : EXTRAS[name];
  }
  if (pkg !== 'std') {
    total += linkPrice(int(o.personalLinks));
    total += int(o.extraVersions) * VERSION;
  }
  return { total };
}
module.exports = { priceOrder, linkPrice };

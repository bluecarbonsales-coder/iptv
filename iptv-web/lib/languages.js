'use strict';
// Canonical language codes for the catalogue and its "browse by language" facet.
//
// iptv-org's feeds.json mostly uses ISO 639-3/T codes (eng, spa, tur), but a minority of
// feeds and every third-party M3U carries something else: the 639-2/B form ("FRE", "GER",
// "DUT", "JAP", "CZE", "ARM") or a plain name ("Spanish", "English"). Unmapped, each variant
// becomes its own entry in the language facet, so the browse page lists "French" AND "FRE",
// "German" AND "GER", and a language filter misses half of that language's channels.
//
// Only clear aliases are merged. Distinct codes that iptv-org deliberately keeps apart
// (zho vs cmn vs yue) are left exactly as they are — the catalogue tests pin them.
const ALIASES = {
  // ISO 639-2/B (bibliographic) -> 639-3/T
  alb: 'sqi', arm: 'hye', baq: 'eus', bur: 'mya', chi: 'zho', cze: 'ces', dut: 'nld',
  fre: 'fra', geo: 'kat', ger: 'deu', gre: 'ell', ice: 'isl', mac: 'mkd', mao: 'mri',
  may: 'msa', per: 'fas', rum: 'ron', slo: 'slk', tib: 'bod', wel: 'cym', jav: 'jav',
  jpn: 'jpn', jap: 'jpn', spa: 'spa', eng: 'eng', tur: 'tur', por: 'por', ara: 'ara', rus: 'rus',
  // ISO 639-1 (two letter) -> 639-3/T for the languages this portal actually carries
  en: 'eng', es: 'spa', tr: 'tur', pt: 'por', fr: 'fra', de: 'deu', it: 'ita', nl: 'nld',
  ar: 'ara', ru: 'rus', zh: 'zho', ja: 'jpn', ko: 'kor', hi: 'hin', bn: 'ben', ur: 'urd',
  fa: 'fas', pl: 'pol', uk: 'ukr', ro: 'ron', el: 'ell', sv: 'swe', da: 'dan', no: 'nor',
  fi: 'fin', cs: 'ces', hu: 'hun', bg: 'bul', sk: 'slk', sr: 'srp', hr: 'hrv', sl: 'slv',
  he: 'heb', th: 'tha', vi: 'vie', id: 'ind', ms: 'msa', tl: 'tgl', sw: 'swa', ta: 'tam',
  te: 'tel', ml: 'mal', kn: 'kan', mr: 'mar', gu: 'guj', pa: 'pan', ne: 'nep', si: 'sin',
  my: 'mya', km: 'khm', lo: 'lao', az: 'aze', kk: 'kaz', uz: 'uzb', ky: 'kir', tg: 'tgk',
  hy: 'hye', ka: 'kat', sq: 'sqi', mk: 'mkd', bs: 'bos', is: 'isl', ga: 'gle', cy: 'cym',
  eu: 'eus', ca: 'cat', gl: 'glg', af: 'afr', am: 'amh', ha: 'hau', yo: 'yor', zu: 'zul',
  // spellings seen in M3U tvg-language attributes
  spanish: 'spa', espanol: 'spa', 'español': 'spa', castilian: 'spa', english: 'eng',
  turkish: 'tur', turkce: 'tur', 'türkçe': 'tur', chinese: 'zho', mandarin: 'zho',
  cantonese: 'yue', arabic: 'ara', french: 'fra', francais: 'fra', 'français': 'fra',
  german: 'deu', deutsch: 'deu', italian: 'ita', italiano: 'ita', portuguese: 'por',
  portugues: 'por', 'português': 'por', russian: 'rus', japanese: 'jpn', korean: 'kor',
  hindi: 'hin', bengali: 'ben', urdu: 'urd', persian: 'fas', farsi: 'fas', polish: 'pol',
  ukrainian: 'ukr', romanian: 'ron', greek: 'ell', swedish: 'swe', danish: 'dan',
  norwegian: 'nor', finnish: 'fin', czech: 'ces', hungarian: 'hun', bulgarian: 'bul',
  slovak: 'slk', serbian: 'srp', croatian: 'hrv', slovenian: 'slv', hebrew: 'heb',
  thai: 'tha', vietnamese: 'vie', indonesian: 'ind', malay: 'msa', tagalog: 'tgl',
  filipino: 'fil', swahili: 'swa', tamil: 'tam', telugu: 'tel', malayalam: 'mal',
  kannada: 'kan', marathi: 'mar', gujarati: 'guj', punjabi: 'pan', panjabi: 'pan',
  nepali: 'nep', sinhala: 'sin', burmese: 'mya', khmer: 'khm', lao: 'lao',
  azerbaijani: 'aze', kazakh: 'kaz', uzbek: 'uzb', armenian: 'hye', georgian: 'kat',
  albanian: 'sqi', macedonian: 'mkd', icelandic: 'isl', irish: 'gle', welsh: 'cym',
  basque: 'eus', catalan: 'cat', galician: 'glg', afrikaans: 'afr', amharic: 'amh',
  hausa: 'hau', yoruba: 'yor',
};

function canonicalLanguage(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (!raw) return null;
  // "es-ES", "spa_Latn", "en (US)" -> the base subtag
  const base = raw.split(/[-–,;/|()\s]+/).filter(Boolean)[0] || '';
  if (!base) return null;
  if (ALIASES[base]) return ALIASES[base];
  if (/^[a-z]{3}$/.test(base)) return base;   // already a 639-3 code (cmn, yue, sgn included)
  if (/^[a-z]{2}$/.test(base)) return base;   // unknown two-letter code: keep, do not guess
  return null;                                 // a name we do not know: better dropped than invented
}

function canonicalLanguages(value) {
  const out = [];
  for (const part of String(value == null ? '' : value).split(/[;,/|]+/)) {
    const code = canonicalLanguage(part);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

// Last-resort language for a channel that carries no tag of its own but does carry a country.
// Several public lists publish only `tvg-country` (Free-TV/IPTV tags every entry AL, ES, TR, US …),
// so without this their channels all fell under "unknown" and the language filters showed none of
// them. Only unambiguous countries are listed — Belgium, Canada, Switzerland and friends are
// deliberately absent because naming one of their languages would be a guess.
const COUNTRY_LANGUAGE = {
  ES: 'spa', MX: 'spa', AR: 'spa', CL: 'spa', CO: 'spa', PE: 'spa', VE: 'spa', UY: 'spa',
  PY: 'spa', BO: 'spa', EC: 'spa', GT: 'spa', CR: 'spa', PA: 'spa', DO: 'spa', CU: 'spa',
  HN: 'spa', SV: 'spa', NI: 'spa', PR: 'spa', US: 'eng', GB: 'eng', AU: 'eng', NZ: 'eng',
  IE: 'eng', TR: 'tur', CN: 'zho', TW: 'zho', HK: 'zho', MO: 'zho', JP: 'jpn', KR: 'kor',
  FR: 'fra', DE: 'deu', IT: 'ita', PT: 'por', BR: 'por', NL: 'nld', RU: 'rus', UA: 'ukr',
  PL: 'pol', RO: 'ron', GR: 'ell', SE: 'swe', DK: 'dan', NO: 'nor', FI: 'fin', CZ: 'ces',
  HU: 'hun', BG: 'bul', SK: 'slk', RS: 'srp', HR: 'hrv', SI: 'slv', IL: 'heb', SA: 'ara',
  AE: 'ara', EG: 'ara', QA: 'ara', KW: 'ara', MA: 'ara', DZ: 'ara', TN: 'ara', JO: 'ara',
  LB: 'ara', IQ: 'ara', SY: 'ara', YE: 'ara', LY: 'ara', SD: 'ara', OM: 'ara', BH: 'ara',
  IR: 'fas', AF: 'fas', PK: 'urd', IN: 'hin', BD: 'ben', LK: 'sin', NP: 'nep', TH: 'tha',
  VN: 'vie', ID: 'ind', MY: 'msa', PH: 'tgl', AZ: 'aze', KZ: 'kaz', UZ: 'uzb', AM: 'hye',
  GE: 'kat', AL: 'sqi', MK: 'mkd', IS: 'isl', ET: 'amh', KE: 'swa', TZ: 'swa', NG: 'eng',
  ZA: 'eng', GH: 'eng', UG: 'eng', ZM: 'eng', ZW: 'eng', MW: 'eng',
};

function fallbackLanguageForCountry(code) {
  const key = String(code == null ? '' : code).trim().toUpperCase();
  return COUNTRY_LANGUAGE[key] || null;
}

module.exports = { ALIASES, COUNTRY_LANGUAGE, canonicalLanguage, canonicalLanguages, fallbackLanguageForCountry };

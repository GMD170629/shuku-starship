export type ParsedRelease = {
  rawTitle: string;
  normalizedTitle: string;
  aliases: string[];
  volume?: number;
  chapter?: number;
  episode?: number;
  language?: string;
  group?: string;
  format?: string;
  quality?: string;
  tags: string[];
};

const formatPattern = /\.(epub|txt|pdf|cbz|zip|rar|7z)$/i;
const releaseFormats = new Set(['epub', 'txt', 'pdf', 'cbz', 'zip', 'rar', '7z']);
const qualityPattern = /\b(4k|2160p|1440p|1080p|720p|480p|web-dl|webrip|hdrip|bdrip|bluray)\b/i;
const languageLabels: Array<[RegExp, string]> = [
  [/简中|简体中文|简体|^sc$/i, '简中'],
  [/繁中|繁體中文|繁体|^tc$/i, '繁中'],
  [/中文|chinese|chs|cht/i, '中文'],
  [/\bJP\b|日文|日本語/i, 'JP'],
  [/\bEN\b|英文|english/i, 'EN']
];

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value.replace(/^0+(?=\d)/, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripPath(input: string) {
  return input.split(/[\\/]/).filter(Boolean).at(-1) ?? input;
}

function detectLanguage(value: string) {
  for (const [pattern, label] of languageLabels) {
    if (pattern.test(value)) return label;
  }
  return undefined;
}

function cleanToken(token: string) {
  return token.replace(/^[\s()[\]【】]+|[\s()[\]【】]+$/g, '').trim();
}

function extractBracketTokens(title: string) {
  const tokens: string[] = [];
  let withoutTokens = title.replace(/^\s*[\[【]([^\]】]{1,80})[\]】]\s*/u, (_match, token: string) => {
    tokens.push(cleanToken(token));
    return '';
  });
  withoutTokens = withoutTokens.replace(/\s*[\[【]([^\]】]{1,80})[\]】]\s*/gu, (_match, token: string) => {
    tokens.push(cleanToken(token));
    return ' ';
  });
  withoutTokens = withoutTokens.replace(/\s*[（(]([^()（）]{1,80})[）)]\s*/gu, (_match, token: string) => {
    tokens.push(cleanToken(token));
    return ' ';
  });
  return { title: withoutTokens, tokens: tokens.filter(Boolean) };
}

function normalizeSeparators(value: string) {
  return value
    .replace(/[_]+/g, ' ')
    .replace(/[·•]+/g, ' ')
    .replace(/\s*[-–—]+\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeNoise(value: string) {
  let next = value;
  const patterns = [
    /第\s*\d+(?:\.\d+)?\s*[章章节話话]/giu,
    /第\s*\d+(?:\.\d+)?\s*[卷冊册]/giu,
    /\b(?:chapter|chap|ch)\.?\s*0*\d+(?:\.\d+)?\b/giu,
    /\bc\s*0*\d+(?:\.\d+)?\b/giu,
    /\b(?:volume|vol)\.?\s*0*\d+(?:\.\d+)?\b/giu,
    /\bv\s*0*\d+(?:\.\d+)?\b/giu,
    /\b(?:episode|ep)\.?\s*0*\d+(?:\.\d+)?\b/giu,
    /\be\s*0*\d+(?:\.\d+)?\b/giu,
    /\b0*\d{1,4}(?:\.\d+)?\b(?=\s*$)/gu
  ];
  for (const pattern of patterns) next = next.replace(pattern, ' ');
  next = next.replace(/[《》]/g, ' ');
  next = next.replace(qualityPattern, ' ');
  next = next.replace(/\b(?:epub|txt|pdf|cbz|zip|rar|7z)\b/giu, ' ');
  next = next.replace(/\s*-\s*$/g, ' ');
  return normalizeSeparators(next).replace(/^[\s\-–—]+|[\s\-–—]+$/g, '').trim();
}

function titleAliases(title: string) {
  const aliases = [title];
  const noBookMarks = title.replace(/[《》]/g, '').trim();
  if (noBookMarks !== title) aliases.push(noBookMarks);
  const compact = noBookMarks.replace(/[\s_\-.()[\]（）【】《》:：,，]+/g, '');
  if (compact && compact !== noBookMarks) aliases.push(compact);
  return unique(aliases);
}

export function parseReleaseTitle(input: string): ParsedRelease {
  const rawTitle = input;
  const fileName = stripPath(input.trim());
  const format = fileName.match(formatPattern)?.[1]?.toLowerCase();
  let working = format ? fileName.replace(formatPattern, '') : fileName;
  working = normalizeSeparators(working);

  const { title: withoutBrackets, tokens } = extractBracketTokens(working);
  const group = tokens.find((token) => !detectLanguage(token) && !releaseFormats.has(token.toLowerCase()) && !qualityPattern.test(token));
  const language = tokens.map(detectLanguage).find(Boolean) ?? detectLanguage(working);
  const quality = (working.match(qualityPattern)?.[1] ?? tokens.find((token) => qualityPattern.test(token)))?.toUpperCase();

  const candidates = [working, withoutBrackets];
  let volume: number | undefined;
  let chapter: number | undefined;
  let episode: number | undefined;

  for (const candidate of candidates) {
    volume ??= parseNumber(candidate.match(/第\s*(\d+(?:\.\d+)?)\s*[卷冊册]/iu)?.[1]);
    volume ??= parseNumber(candidate.match(/\b(?:volume|vol)\.?\s*0*(\d+(?:\.\d+)?)\b/iu)?.[1]);
    volume ??= parseNumber(candidate.match(/\bv\s*0*(\d+(?:\.\d+)?)\b/iu)?.[1]);

    chapter ??= parseNumber(candidate.match(/第\s*(\d+(?:\.\d+)?)\s*[章章节話话]/iu)?.[1]);
    chapter ??= parseNumber(candidate.match(/\b(?:chapter|chap|ch)\.?\s*0*(\d+(?:\.\d+)?)\b/iu)?.[1]);
    chapter ??= parseNumber(candidate.match(/\bc\s*0*(\d+(?:\.\d+)?)\b/iu)?.[1]);

    episode ??= parseNumber(candidate.match(/\b(?:episode|ep)\.?\s*0*(\d+(?:\.\d+)?)\b/iu)?.[1]);
    episode ??= parseNumber(candidate.match(/\be\s*0*(\d+(?:\.\d+)?)\b/iu)?.[1]);
  }

  if (chapter === undefined && volume === undefined) {
    chapter = parseNumber(withoutBrackets.match(/(?:^|\s+-\s+|\s)0*(\d{1,4}(?:\.\d+)?)\s*$/u)?.[1]);
  }

  const normalizedTitle = removeNoise(withoutBrackets);
  const tags = unique([
    ...tokens.filter((token) => token !== group && detectLanguage(token) !== language),
    language ?? '',
    quality ?? '',
    format ?? ''
  ]);

  return {
    rawTitle,
    normalizedTitle,
    aliases: titleAliases(normalizedTitle),
    ...(volume !== undefined ? { volume } : {}),
    ...(chapter !== undefined ? { chapter } : {}),
    ...(episode !== undefined ? { episode } : {}),
    ...(language ? { language } : {}),
    ...(group ? { group } : {}),
    ...(format ? { format } : {}),
    ...(quality ? { quality } : {}),
    tags
  };
}

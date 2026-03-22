const DEFAULT_NG_WORDS = [
  "死ね", "しね", "氏ね",
  "殺す", "ころす",
  "カス", "かす",
  "ゴミ", "ごみ",
  "クソ", "くそ",
  "うざい", "ウザい", "ウザイ",
  "きもい", "キモい", "キモイ",
  "消えろ", "消えな",
  "雑魚", "ザコ", "ざこ",
  "ks", "KS",
  "アホ", "あほ",
  "バカ", "ばか", "馬鹿",
  "チンカス",
  "下手くそ", "へたくそ", "ヘタクソ",
  "邪魔", "じゃま",
  "noob", "下手",
];

// 漢字→ひらがな読みマップ（暴言に使われる漢字のみ）
const KANJI_MAP: Record<string, string> = {
  "死": "し", "殺": "ころ", "消": "き",
  "雑": "ざ", "魚": "こ", "馬": "ば", "鹿": "か",
  "下": "へ", "手": "た", "邪": "じゃ", "魔": "ま",
  "氏": "し",
};

const STORAGE_KEY_CUSTOM = "bogen-guard-custom-words";
const STORAGE_KEY_DISABLED = "bogen-guard-disabled-words";
const STORAGE_KEY_HIRAGANA = "bogen-guard-hiragana-mode";

export interface ProfanityResult {
  detected: boolean;
  word: string | null;
}

// カタカナ→ひらがな変換
function katakanaToHiragana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

// 漢字→ひらがな変換（既知の暴言漢字のみ）
function kanjiToHiragana(str: string): string {
  let result = "";
  for (const ch of str) {
    result += KANJI_MAP[ch] || ch;
  }
  return result;
}

// テキストをひらがな正規化
function normalizeToHiragana(str: string): string {
  return kanjiToHiragana(katakanaToHiragana(str.toLowerCase()));
}

export function getHiraganaMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_HIRAGANA) === "true";
  } catch {
    return false;
  }
}

export function setHiraganaMode(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY_HIRAGANA, String(enabled));
}

export function getDefaultWords(): string[] {
  return [...DEFAULT_NG_WORDS];
}

export function getCustomWords(): string[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_CUSTOM);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveCustomWords(words: string[]): void {
  localStorage.setItem(STORAGE_KEY_CUSTOM, JSON.stringify(words));
}

export function getDisabledWords(): string[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_DISABLED);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveDisabledWords(words: string[]): void {
  localStorage.setItem(STORAGE_KEY_DISABLED, JSON.stringify(words));
}

export function getAllActiveWords(): string[] {
  const disabled = new Set(getDisabledWords().map(w => w.toLowerCase()));
  const defaults = DEFAULT_NG_WORDS.filter(w => !disabled.has(w.toLowerCase()));
  const custom = getCustomWords();
  return [...defaults, ...custom];
}

export function checkProfanity(text: string): ProfanityResult {
  const hiraganaMode = getHiraganaMode();
  const normalizedText = hiraganaMode ? normalizeToHiragana(text) : text.toLowerCase();
  const activeWords = getAllActiveWords();

  for (const word of activeWords) {
    const normalizedWord = hiraganaMode ? normalizeToHiragana(word) : word.toLowerCase();
    if (normalizedText.includes(normalizedWord)) {
      return { detected: true, word };
    }
  }

  return { detected: false, word: null };
}

export function countProfanity(text: string): number {
  const hiraganaMode = getHiraganaMode();
  const normalizedText = hiraganaMode ? normalizeToHiragana(text) : text.toLowerCase();
  const activeWords = getAllActiveWords();
  let count = 0;

  // Dedupe normalized words to avoid double counting
  const seen = new Set<string>();
  for (const word of activeWords) {
    const w = hiraganaMode ? normalizeToHiragana(word) : word.toLowerCase();
    if (seen.has(w)) continue;
    seen.add(w);

    let pos = 0;
    while ((pos = normalizedText.indexOf(w, pos)) !== -1) {
      count++;
      pos += w.length;
    }
  }

  return count;
}

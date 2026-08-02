// ========== Schimpfwort-Erkennung (erweitert) ==========

const LEET_MAP = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '@': 'a', '$': 's', '!': 'i', '+': 't', '*': '', '#': '', '€': 'e', '§': 's',
    'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a',
    'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
    'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
    'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o',
    'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
    'ý': 'y', 'ÿ': 'y', 'ñ': 'n', 'ç': 'c',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j'
};

let badWordsSet = new Set();
let badWordsOriginal = [];
let shortBadWords = new Set();
let longBadWords = [];

function mapLeetChar(ch) {
    return LEET_MAP[ch] !== undefined ? LEET_MAP[ch] : ch;
}

function normalizeForProfanity(text) {
    if (!text) return '';
    let s = String(text).toLowerCase();
    try {
        s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    } catch (_) {}
    s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
    let out = '';
    for (let i = 0; i < s.length; i++) {
        out += mapLeetChar(s[i]);
    }
    s = out;
    s = s.replace(/([a-z])[^a-z]+(?=[a-z])/g, '$1');
    s = s.replace(/(.)\1{2,}/g, '$1$1');
    return s;
}

function lettersOnly(text) {
    return String(text).replace(/[^a-z]/g, '');
}

function collapseRepeats(text) {
    return String(text).replace(/(.)\1+/g, '$1');
}

function rebuildBadWordIndexes() {
    badWordsSet = new Set();
    shortBadWords = new Set();
    longBadWords = [];
    for (const word of badWordsOriginal) {
        const n = lettersOnly(normalizeForProfanity(word));
        if (n.length < 2) continue;
        badWordsSet.add(n);
        badWordsSet.add(collapseRepeats(n));
        if (n.length <= 3) {
            shortBadWords.add(n);
            shortBadWords.add(collapseRepeats(n));
        } else {
            longBadWords.push(n);
            const c = collapseRepeats(n);
            if (c !== n) longBadWords.push(c);
        }
    }
    longBadWords = [...new Set(longBadWords)];
}

function findBadWord(text) {
    if (!text || badWordsOriginal.length === 0) return null;
    const lower = text.toLowerCase();
    for (const word of badWordsOriginal) {
        if (word.length < 2) continue;
        const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
            const re = new RegExp('(?:^|[^\\p{L}\\p{N}_])' + esc + '(?:$|[^\\p{L}\\p{N}_])', 'iu');
            if (re.test(lower)) return word;
        } catch (_) {
            const re2 = new RegExp('(?:^|[^a-zA-Z0-9äöüÄÖÜß])' + esc + '(?:$|[^a-zA-Z0-9äöüÄÖÜß])', 'i');
            if (re2.test(lower)) return word;
        }
    }
    const norm = normalizeForProfanity(text);
    const tokens = norm.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
    const collapsedTokens = tokens.map(t => collapseRepeats(lettersOnly(t)));
    const letterTokens = tokens.map(t => lettersOnly(t));
    const fullLetters = lettersOnly(norm);
    const fullCollapsed = collapseRepeats(fullLetters);
    for (const t of letterTokens) {
        if (shortBadWords.has(t) || shortBadWords.has(collapseRepeats(t))) return t;
    }
    for (const t of collapsedTokens) {
        if (shortBadWords.has(t)) return t;
    }
    for (const word of longBadWords) {
        if (letterTokens.includes(word) || collapsedTokens.includes(word)) return word;
        if (word.length >= 5 && (fullLetters.includes(word) || fullCollapsed.includes(word))) return word;
    }
    return null;
}

function containsBadWords(text) {
    return findBadWord(text) !== null;
}

export function setWordList(words) {
    badWordsOriginal = words || [];
    rebuildBadWordIndexes();
}

export function getWordCount() {
    return badWordsOriginal.length;
}

export function getIndexSize() {
    return badWordsSet.size;
}

export {
    containsBadWords,
    findBadWord,
    normalizeForProfanity,
    rebuildBadWordIndexes
};

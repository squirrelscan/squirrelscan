// Conventional link labels (pub#839).
//
// "Sign in", "Terms", "Privacy policy" and "Impressum" name their destination. They are the
// standard label for an account action or a site-utility page, not "click here", so a rule
// that judges link text must leave them alone. This module is the one list of them, in the
// languages a real audit meets, for the link rules to share.
//
// MATCHING. A label counts only when the WHOLE normalised link text equals an entry, never a
// substring. The set is the union across languages: no page language is detected, because a
// page rarely declares its language reliably and a label such as "contact" is the same
// conventional label in half a dozen of them. The set can only REMOVE findings, so a wrong
// entry hides a finding and can never add a false one. Add an entry only when it is the
// standard label in that language.
//
// NORMALISATION. `normalizeLinkLabel` is applied to the link text AND to every entry here, so
// the two always compare in the same form: Unicode NFKC (full-width Latin and half-width
// katakana fold to their plain forms), lowercase, diacritics dropped from Latin letters only
// (so "Impressum", "politique de confidentialité" and "politique de confidentialite" agree
// while the dakuten of ログイン and the breve of "выйти" stay), `&` read as "and", hyphens and
// underscores read as spaces ("Sign-in" is "sign in"), whitespace collapsed (NBSP and the
// ideographic space included), and punctuation, symbols and spaces trimmed off both ends
// (full-width ！？：、「」 and a trailing arrow such as → » › included). Nothing is split on
// word boundaries, since CJK text has none.

/**
 * Longest raw text worth normalising. No conventional label comes near it, and link text can
 * be a paragraph, so anything longer is not a label. It bounds the cost of a hostile page;
 * normalisation itself is linear.
 */
const MAX_RAW_LENGTH = 256;

// Invisible formatting: zero-width space and joiners, the direction marks (LRM, RLM and the
// embedding controls), the word joiner, the byte-order mark and the emoji variation selectors.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufe0e\ufe0f]/g;
const CURLY_APOSTROPHES = /[\u2018\u2019\u201b\u02bc`\u00b4]/g;
const DASHES = /[-_\u2010-\u2015\u2212]+/g;
const LATIN_MARKS = /(\p{Script=Latin})\p{M}+/gu;
const EDGE_CHARACTER = /^[\p{P}\p{S}\p{Z}\s]$/u;

/**
 * `text` without the punctuation, symbols and spaces at both ends. A single pass from each
 * end, not a regex alternation, so a long run of punctuation inside the text costs nothing
 * extra (an unanchored `[...]+$` retries from every position of such a run).
 */
function trimEdges(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end) {
    const code = text.codePointAt(start) as number;
    const width = code > 0xffff ? 2 : 1;
    if (!EDGE_CHARACTER.test(text.slice(start, start + width))) break;
    start += width;
  }
  while (end > start) {
    const last = text.charCodeAt(end - 1);
    const isLowSurrogate = last >= 0xdc00 && last <= 0xdfff && end - 2 >= start;
    const width = isLowSurrogate ? 2 : 1;
    if (!EDGE_CHARACTER.test(text.slice(end - width, end))) break;
    end -= width;
  }
  return text.slice(start, end);
}

/** The form link text and the label entries are compared in. See the file header. */
export function normalizeLinkLabel(text: string): string {
  // Apostrophe look-alikes first: NFKC would split the acute accent into a space and a mark.
  const folded = text
    .replace(CURLY_APOSTROPHES, "'")
    .normalize("NFKC")
    .toLowerCase()
    .replace(INVISIBLE, "")
    .replace(/\u00df/g, "ss")
    .normalize("NFD")
    .replace(LATIN_MARKS, "$1")
    .normalize("NFC")
    .replace(/&/g, " and ")
    .replace(DASHES, " ")
    .replace(/\s+/g, " ");
  return trimEdges(folded).replace(/\s+/g, " ").trim();
}

export type ConventionalLabelKind = "account" | "legal";

/** Languages the labels cover, in the order the docs list them. */
export const CONVENTIONAL_LABEL_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "nl",
  "ja",
  "zh",
  "ko",
  "ru",
] as const;

export type ConventionalLabelLanguage = (typeof CONVENTIONAL_LABEL_LANGUAGES)[number];

type LabelTable = Record<ConventionalLabelKind, Record<ConventionalLabelLanguage, readonly string[]>>;

/**
 * The labels as a reader writes them; accents, case and punctuation do not matter, because
 * entries are normalised on load. `account` is an account action (sign in, sign up, log out,
 * register, my account). `legal` is a legal or site-utility page (terms, privacy, imprint,
 * DMCA, cookies, accessibility, sitemap, contact, about, help, FAQ, careers).
 */
export const CONVENTIONAL_LINK_LABELS: LabelTable = {
  account: {
    en: [
      "sign in",
      "signin",
      "sign up",
      "signup",
      "log in",
      "login",
      "log out",
      "logout",
      "sign out",
      "signout",
      "register",
      "registration",
      "my account",
      "account",
      "create account",
      "create an account",
      "forgot password",
      "forgot your password",
      "reset password",
    ],
    es: [
      "iniciar sesión",
      "inicia sesión",
      "entrar",
      "acceder",
      "ingresar",
      "registrarse",
      "regístrate",
      "registro",
      "crear cuenta",
      "crear una cuenta",
      "cerrar sesión",
      "salir",
      "mi cuenta",
      "cuenta",
    ],
    fr: [
      "connexion",
      "se connecter",
      "s'identifier",
      "inscription",
      "s'inscrire",
      "créer un compte",
      "déconnexion",
      "se déconnecter",
      "mon compte",
      "compte",
    ],
    de: [
      "anmelden",
      "anmeldung",
      "einloggen",
      "login",
      "registrieren",
      "registrierung",
      "abmelden",
      "ausloggen",
      "mein konto",
      "konto",
      "konto erstellen",
    ],
    pt: [
      "entrar",
      "login",
      "iniciar sessão",
      "registar",
      "registrar",
      "registar-se",
      "cadastrar",
      "cadastre-se",
      "cadastro",
      "criar conta",
      "sair",
      "terminar sessão",
      "minha conta",
      "a minha conta",
      "conta",
    ],
    it: [
      "accedi",
      "accesso",
      "login",
      "registrati",
      "registrazione",
      "iscriviti",
      "esci",
      "disconnetti",
      "il mio account",
      "account",
      "crea account",
      "area riservata",
    ],
    nl: [
      "inloggen",
      "aanmelden",
      "login",
      "registreren",
      "uitloggen",
      "afmelden",
      "mijn account",
      "account",
      "account aanmaken",
    ],
    ja: [
      "ログイン",
      "サインイン",
      "新規登録",
      "新規会員登録",
      "会員登録",
      "サインアップ",
      "登録",
      "ログアウト",
      "サインアウト",
      "マイページ",
      "アカウント",
    ],
    zh: [
      "登录",
      "登入",
      "注册",
      "註冊",
      "退出",
      "退出登录",
      "登出",
      "我的账户",
      "我的账号",
      "我的帐户",
      "我的帳戶",
      "账户",
      "帳戶",
    ],
    ko: [
      "로그인",
      "회원가입",
      "가입하기",
      "로그아웃",
      "내 계정",
      "마이페이지",
    ],
    ru: [
      "войти",
      "вход",
      "регистрация",
      "зарегистрироваться",
      "выйти",
      "выход",
      "личный кабинет",
      "мой аккаунт",
      "аккаунт",
      "создать аккаунт",
    ],
  },
  legal: {
    en: [
      "terms",
      "terms of service",
      "terms of use",
      "terms and conditions",
      "terms & conditions",
      "t&c",
      "t&cs",
      "tos",
      "privacy",
      "privacy policy",
      "privacy notice",
      "legal",
      "legal notice",
      "legal information",
      "imprint",
      "dmca",
      "copyright",
      "disclaimer",
      "cookies",
      "cookie policy",
      "cookie settings",
      "cookie preferences",
      "accessibility",
      "accessibility statement",
      "sitemap",
      "site map",
      "contact",
      "contact us",
      "about",
      "about us",
      "help",
      "help center",
      "help centre",
      "support",
      "faq",
      "faqs",
      "careers",
      "jobs",
      "press",
    ],
    es: [
      "términos y condiciones",
      "términos de servicio",
      "términos de uso",
      "condiciones de uso",
      "política de privacidad",
      "privacidad",
      "aviso legal",
      "aviso de privacidad",
      "política de cookies",
      "cookies",
      "accesibilidad",
      "mapa del sitio",
      "contacto",
      "contáctanos",
      "contáctenos",
      "acerca de",
      "sobre nosotros",
      "quiénes somos",
      "ayuda",
      "soporte",
      "preguntas frecuentes",
      "empleo",
      "trabaja con nosotros",
      "derechos de autor",
    ],
    fr: [
      "mentions légales",
      "politique de confidentialité",
      "confidentialité",
      "conditions générales",
      "conditions générales d'utilisation",
      "conditions générales de vente",
      "conditions d'utilisation",
      "cgu",
      "cgv",
      "cookies",
      "politique de cookies",
      "gestion des cookies",
      "accessibilité",
      "plan du site",
      "contact",
      "nous contacter",
      "contactez-nous",
      "à propos",
      "qui sommes-nous",
      "aide",
      "support",
      "faq",
      "foire aux questions",
      "carrières",
      "emplois",
      "recrutement",
      "droit d'auteur",
      "dmca",
    ],
    de: [
      "impressum",
      "datenschutz",
      "datenschutzerklärung",
      "datenschutzerklaerung",
      "agb",
      "allgemeine geschäftsbedingungen",
      "allgemeine geschaeftsbedingungen",
      "nutzungsbedingungen",
      "rechtliches",
      "rechtliche hinweise",
      "cookies",
      "cookie-richtlinie",
      "cookie-einstellungen",
      "barrierefreiheit",
      "sitemap",
      "kontakt",
      "über uns",
      "ueber uns",
      "hilfe",
      "support",
      "faq",
      "häufige fragen",
      "karriere",
      "jobs",
      "urheberrecht",
    ],
    pt: [
      "termos",
      "termos de serviço",
      "termos de uso",
      "termos e condições",
      "política de privacidade",
      "privacidade",
      "aviso legal",
      "política de cookies",
      "cookies",
      "acessibilidade",
      "mapa do site",
      "contato",
      "contacto",
      "fale conosco",
      "contacte-nos",
      "sobre",
      "sobre nós",
      "quem somos",
      "ajuda",
      "suporte",
      "perguntas frequentes",
      "faq",
      "carreiras",
      "empregos",
      "direitos autorais",
    ],
    it: [
      "termini e condizioni",
      "termini di servizio",
      "termini d'uso",
      "condizioni generali",
      "condizioni d'uso",
      "informativa sulla privacy",
      "privacy policy",
      "privacy",
      "note legali",
      "informazioni legali",
      "cookie policy",
      "cookie",
      "accessibilità",
      "mappa del sito",
      "contatti",
      "contattaci",
      "chi siamo",
      "aiuto",
      "assistenza",
      "supporto",
      "faq",
      "domande frequenti",
      "lavora con noi",
      "carriere",
      "diritto d'autore",
    ],
    nl: [
      "algemene voorwaarden",
      "voorwaarden",
      "gebruiksvoorwaarden",
      "privacy",
      "privacybeleid",
      "privacyverklaring",
      "disclaimer",
      "cookies",
      "cookiebeleid",
      "toegankelijkheid",
      "sitemap",
      "contact",
      "neem contact op",
      "over ons",
      "help",
      "hulp",
      "ondersteuning",
      "faq",
      "veelgestelde vragen",
      "vacatures",
      "carrière",
    ],
    ja: [
      "利用規約",
      "プライバシーポリシー",
      "個人情報保護方針",
      "特定商取引法に基づく表記",
      "特定商取引法表記",
      "特商法表記",
      "著作権",
      "クッキーポリシー",
      "サイトマップ",
      "お問い合わせ",
      "お問合せ",
      "問い合わせ",
      "会社概要",
      "ヘルプ",
      "サポート",
      "よくある質問",
      "採用情報",
      "求人",
      "アクセシビリティ",
    ],
    zh: [
      "服务条款",
      "服務條款",
      "使用条款",
      "使用條款",
      "隐私政策",
      "隱私政策",
      "隱私權政策",
      "隐私",
      "法律声明",
      "法律聲明",
      "版权",
      "版權",
      "无障碍",
      "网站地图",
      "網站地圖",
      "联系我们",
      "聯絡我們",
      "聯繫我們",
      "关于我们",
      "關於我們",
      "帮助",
      "幫助",
      "常见问题",
      "常見問題",
      "招聘",
      "人才招聘",
    ],
    ko: [
      "이용약관",
      "서비스 이용약관",
      "개인정보처리방침",
      "개인정보 처리방침",
      "개인정보보호정책",
      "저작권",
      "쿠키 정책",
      "접근성",
      "사이트맵",
      "문의하기",
      "문의",
      "연락처",
      "회사소개",
      "소개",
      "도움말",
      "고객센터",
      "자주 묻는 질문",
      "채용",
      "채용정보",
    ],
    ru: [
      "условия использования",
      "пользовательское соглашение",
      "условия",
      "политика конфиденциальности",
      "конфиденциальность",
      "правовая информация",
      "авторское право",
      "куки",
      "политика cookie",
      "доступность",
      "карта сайта",
      "контакты",
      "связаться с нами",
      "о нас",
      "о компании",
      "помощь",
      "поддержка",
      "faq",
      "часто задаваемые вопросы",
      "карьера",
      "вакансии",
    ],
  },
};

/** Every label across kinds and languages, normalised. */
const CONVENTIONAL_SET: ReadonlySet<string> = new Set(
  Object.values(CONVENTIONAL_LINK_LABELS).flatMap((byLanguage) =>
    Object.values(byLanguage).flatMap((labels) => labels.map(normalizeLinkLabel)),
  ),
);

/**
 * True when the whole link text is a conventional account or site-utility label in any
 * covered language, however it is cased, punctuated or spaced.
 */
export function isConventionalLinkLabel(text: string): boolean {
  if (text.length === 0 || text.length > MAX_RAW_LENGTH) return false;
  return CONVENTIONAL_SET.has(normalizeLinkLabel(text));
}

// Conventional account and site-utility link labels (pub#839).
//
// A link that reads "Sign in", "Log out", "Terms" or "Privacy policy" names its
// destination: it is not "click here". Link rules that flag generic text check
// this set first and let it win, so a header or footer template does not turn
// into one finding per page.
//
// The set is matched on the WHOLE normalised link text and is the union across
// languages, so no page language detection is needed. It can only remove
// findings, so a wrong entry never adds a false positive.

/** Account actions: sign in/up/out, register, my account. */
const ACCOUNT_LABELS: readonly string[] = [
  // en
  "sign in", "signin", "sign up", "signup", "log in", "login", "log out", "logout",
  "sign out", "signout", "register", "my account", "account", "create account",
  "create an account",
  // es
  "iniciar sesion", "iniciar sesión", "inicia sesion", "inicia sesión", "acceder",
  "entrar", "registrarse", "registrate", "regístrate", "crear cuenta", "cerrar sesion",
  "cerrar sesión", "mi cuenta",
  // fr
  "connexion", "se connecter", "inscription", "s'inscrire", "creer un compte",
  "créer un compte", "deconnexion", "déconnexion", "se deconnecter", "se déconnecter",
  "mon compte",
  // de
  "anmelden", "einloggen", "registrieren", "abmelden", "ausloggen", "konto erstellen",
  "mein konto", "kundenkonto",
  // pt
  "entrar", "iniciar sessao", "iniciar sessão", "cadastrar", "cadastre-se", "registrar",
  "registrar-se", "criar conta", "sair", "minha conta",
  // it
  "accedi", "accesso", "registrati", "registrazione", "iscriviti", "esci", "il mio account",
  "crea account", "area personale",
  // nl
  "inloggen", "aanmelden", "registreren", "uitloggen", "afmelden", "account aanmaken",
  "mijn account",
  // ja
  "ログイン", "サインイン", "新規登録", "会員登録", "ログアウト", "サインアップ", "マイページ",
  // zh
  "登录", "登錄", "注册", "註冊", "退出", "退出登录", "登出", "我的账户", "我的帐户", "我的帳戶",
  // ko
  "로그인", "회원가입", "로그아웃", "가입하기", "내 계정", "마이페이지",
  // ru
  "войти", "вход", "регистрация", "зарегистрироваться", "выйти", "выход", "личный кабинет",
  "мой аккаунт",
];

/** Legal and site-utility labels: terms, privacy, imprint, cookies, contact, about, help. */
const UTILITY_LABELS: readonly string[] = [
  // en
  "terms", "terms of service", "terms of use", "terms and conditions", "terms & conditions",
  "privacy", "privacy policy", "privacy notice", "legal", "legal notice", "imprint", "dmca",
  "cookies", "cookie policy", "cookie settings", "accessibility", "accessibility statement",
  "sitemap", "site map", "contact", "contact us", "about", "about us", "help", "faq", "faqs",
  "careers", "jobs", "support", "disclaimer",
  // es
  "terminos", "términos", "terminos y condiciones", "términos y condiciones",
  "terminos de servicio", "términos de servicio", "condiciones de uso", "privacidad",
  "politica de privacidad", "política de privacidad", "aviso legal", "politica de cookies",
  "política de cookies", "accesibilidad", "mapa del sitio", "contacto", "contactanos",
  "contáctanos", "sobre nosotros", "acerca de", "ayuda", "preguntas frecuentes", "empleo",
  "carreras", "soporte",
  // fr
  "conditions generales", "conditions générales", "conditions d'utilisation",
  "cgu", "cgv", "confidentialite", "confidentialité", "politique de confidentialite",
  "politique de confidentialité", "mentions legales", "mentions légales", "politique de cookies",
  "accessibilite", "accessibilité", "plan du site", "nous contacter", "contactez-nous",
  "a propos", "à propos", "aide", "carrieres", "carrières", "assistance",
  // de
  "agb", "nutzungsbedingungen", "datenschutz", "datenschutzerklarung", "datenschutzerklärung",
  "impressum", "rechtliches", "cookie-richtlinie", "cookie richtlinie", "barrierefreiheit",
  "sitemap", "kontakt", "ueber uns", "über uns", "hilfe", "haufige fragen", "häufige fragen",
  "karriere", "support",
  // pt
  "termos", "termos de uso", "termos e condicoes", "termos e condições", "termos de servico",
  "termos de serviço", "privacidade", "politica de privacidade", "política de privacidade",
  "aviso legal", "politica de cookies", "política de cookies", "acessibilidade",
  "mapa do site", "contato", "contacto", "fale conosco", "sobre nos", "sobre nós", "sobre",
  "ajuda", "perguntas frequentes", "carreiras", "suporte",
  // it
  "termini", "termini di servizio", "termini e condizioni", "condizioni d'uso", "privacy",
  "informativa sulla privacy", "note legali", "cookie policy", "accessibilita", "accessibilità",
  "mappa del sito", "contatti", "contattaci", "chi siamo", "aiuto", "domande frequenti",
  "lavora con noi", "carriere", "supporto",
  // nl
  "voorwaarden", "algemene voorwaarden", "gebruiksvoorwaarden", "privacybeleid",
  "privacyverklaring", "juridische informatie", "cookiebeleid", "toegankelijkheid",
  "sitemap", "contact", "over ons", "hulp", "veelgestelde vragen", "vacatures", "ondersteuning",
  // ja
  "利用規約", "プライバシーポリシー", "個人情報保護方針", "特定商取引法に基づく表記",
  "クッキーポリシー", "アクセシビリティ", "サイトマップ", "お問い合わせ", "会社概要",
  "ヘルプ", "よくある質問", "採用情報", "サポート",
  // zh
  "服务条款", "服務條款", "使用条款", "使用條款", "隐私政策", "隱私政策", "隐私", "隱私",
  "法律声明", "法律聲明", "免责声明", "免責聲明", "cookie政策", "无障碍", "網站地圖",
  "网站地图", "联系我们", "聯絡我們", "关于我们", "關於我們", "帮助", "幫助", "常见问题",
  "常見問題", "招聘", "加入我们", "加入我們", "支持",
  // ko
  "이용약관", "서비스 약관", "개인정보처리방침", "개인정보 처리방침", "개인정보", "법적 고지",
  "쿠키 정책", "접근성", "사이트맵", "문의하기", "문의", "회사 소개", "소개", "도움말",
  "자주 묻는 질문", "채용", "고객지원",
  // ru
  "условия использования", "пользовательское соглашение", "условия", "конфиденциальность",
  "политика конфиденциальности", "правовая информация", "политика cookie", "доступность",
  "карта сайта", "контакты", "связаться с нами", "о нас", "о компании", "помощь", "справка",
  "часто задаваемые вопросы", "вопросы и ответы", "вакансии", "карьера", "поддержка",
];

/**
 * Normalises link text for the whole-text label match: Unicode NFKC (folds
 * full-width forms and non-breaking spaces), case folding, leading and trailing
 * punctuation and symbols removed (ASCII and full-width), inner whitespace
 * collapsed.
 */
export function normalizeLinkLabel(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\s ]+/g, " ")
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
}

const CONVENTIONAL_LABELS: ReadonlySet<string> = new Set(
  [...ACCOUNT_LABELS, ...UTILITY_LABELS].map(normalizeLinkLabel),
);

/** Whether the whole link text is a conventional account or site-utility label. */
export function isConventionalLinkLabel(text: string): boolean {
  const normalized = normalizeLinkLabel(text);
  return normalized.length > 0 && CONVENTIONAL_LABELS.has(normalized);
}

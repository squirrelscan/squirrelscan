// Stopwords for content/h1-title-alignment (pub#929), per primary language
// subtag. Whitespace-delimited Latin-script languages only: a language not
// listed here is skipped by the rule, never judged. Words are lower-case with
// diacritics folded (the rule folds the text the same way before the lookup).

const LISTS: Record<string, string> = {
  en: "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further get gets had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours",
  es: "a al algo algun alguna algunas alguno algunos ante antes como con contra cual cuando de del desde donde durante e el ella ellas ellos en entre era eran es esa esas ese eso esos esta estas este esto estos fue ha han hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o os otra otras otro otros para pero por porque que quien se sea ser si sin sobre su sus tambien tan te tiene todo todos tu tus un una unas uno unos y ya yo",
  fr: "a ai au aux avec ce ces cet cette dans de des du elle elles en es est et etre eu il ils je la le les leur leurs lui ma mais me mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses si son sont sur ta te tes toi ton tu un une vos votre vous",
  de: "aber alle als also am an auch auf aus bei bin bis bist da damit dann das dass dein deine dem den der des die dies diese dieser dieses doch du durch ein eine einem einen einer eines er es euer fur hab hat haben hier ich ihr ihre im in ist ja kann kein keine mehr mein meine mit nach nicht noch nur oder ohne sehr sein seine sich sie sind so uber um und uns unser unsere von vor war was weil wenn wer wie wir wird wo zu zum zur",
  pt: "a ao aos as com como da das de dela dele deles do dos e ela elas ele eles em entre era essa esse esta este eu foi ha isso isto ja la mais mas me meu minha muito na nas nao nem no nos nossa nosso num numa o os ou para pela pelas pelo pelos por qual quando que quem se sem ser seu sua so sobre tambem te tem um uma voce",
  it: "a ad al alla alle allo anche avere che chi ci come con cui da dal dalla dei del della delle dello di e ed era essere gli ha hanno ho i il in io la le lei lo loro lui ma me mi molto ne nei nel nella no noi non o per perche piu quella quello questa questo se si sono su sua suo tra tu tutti un una uno vi voi",
  nl: "aan al als bij dan dat de den der deze die dit doch door dus een en er geen had heb heeft hem het hier hij hoe hun ik in is je kan maar me met mij mijn na naar niet nog nu of om onder ons ook op over reeds te tegen toen tot u uit van veel voor was wat we wel werd wij wil worden zal ze zei zij zijn zo zou",
};

export const H1_TITLE_STOPWORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(LISTS).map(([lang, words]) => [lang, new Set(words.split(" "))]),
);

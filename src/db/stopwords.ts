/** Curated English + Russian function-word stopwords for query-side FTS filtering. */
const EN_STOPWORDS =
  `a an the and or not but if then else of to in on at by for with as is are was were be been being do does did doing have has had having i you he she it we they me him her us them my your his its our their this that these those what which who whom whose when where why how all any both each few more most other some such no nor only own same so than too very can will just should now from into over about up down out off again further once here there`
    .split(' ')

const RU_STOPWORDS =
  `и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это такое`
    .split(' ')

const STOPWORDS: ReadonlySet<string> = new Set([...EN_STOPWORDS, ...RU_STOPWORDS])

/** Unicode-aware normalisation: lower-case, fold `ё`→`е` so variants match. */
function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/ё/g, 'е')
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(normalizeToken(token))
}

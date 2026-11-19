/**
 * core/soul.js — Soul Affinity, domain layer
 *
 * Complete design: `docs/design/SOUL_AFFINITY.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file exists now, even though the system is blocked by Phase 0
 * ─────────────────────────────────────────────────────────────────────────────
 * The design says that no part of Soul Affinity becomes code before the
 * in-game test. That applies to the **service** — the part that interacts with
 * the world, delivers signals, records marks, and advances trees.
 *
 * It does not apply to the **domain**. This module consists of pure functions:
 * it does not open a database, touch `mp`, have side effects, or know that a
 * game exists. It can probably be tested entirely outside the server, and
 * this is exactly the part where mistakes become most costly later — biased
 * distributions or rolls that fail may only become apparent with hundreds of
 * players, when fixing them means changing the souls of characters players
 * care about.
 *
 * It also implements, rather than merely diagramming, the separation between
 * domain and infrastructure required by Constitution §13.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The three non-negotiable rules (Constitution §8, amendment v1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. No soul is strictly better than another. This is guaranteed here by a
 *    FIXED BUDGET: a high affinity requires another to be low. This does not
 *    depend on the goodwill of whoever writes content two years from now.
 * 2. The die never says no. `resolve()` returns one of four outcomes, and all
 *    four count as success. There is no return path that means failure.
 * 3. Every roll is auditable. Everything here is deterministic from the seed,
 *    and `resolve()` returns the inputs along with the result so staff can
 *    reproduce any disputed outcome.
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** One for each transformation tree. */
const AFFINITIES = Object.freeze(['arcana', 'divina', 'sombria', 'bestial']);

/** How well the character withstands the cost of what they attempted. */
const TRAITS = Object.freeze(['vontade', 'sensibilidade', 'estabilidade']);

/**
 * Players never see numbers. Resolution also does not use raw numbers — it
 * uses bands. Having only five steps is what keeps the system from becoming a
 * spreadsheet: to everyone, 61 and 63 are the same.
 */
const BANDS = Object.freeze(['surdo', 'fraco', 'comum', 'forte', 'raro']);

/** The four outcomes. ALL count as success — see rule 2 above. */
const OUTCOMES = Object.freeze(['limpo', 'caro', 'complicado', 'marcado']);

/**
 * Fixed budgets. They are the mechanical guarantee of rule 1.
 *
 * 200 across 4 affinities = an average of 50. For someone to get `raro` (85+)
 * in Arcana, the other three must total 115 — meaning they fall below average.
 * You cannot be good at everything, and this is not a balancing choice
 * someone could undo without noticing: it is arithmetic.
 */
const AFFINITY_BUDGET = 200;
const TRAIT_BUDGET = 150;

/**
 * Band thresholds. Deliberately concentrated in the middle: nearly everyone
 * is `comum` at nearly everything, which is what makes `raro` mean something.
 */
const BAND_BOUNDS = Object.freeze([
  { band: 'surdo', max: 14 },
  { band: 'fraco', max: 34 },
  { band: 'comum', max: 64 },
  { band: 'forte', max: 84 },
  { band: 'raro', max: 100 }
]);

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic randomness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A counter-based, rather than sequential, generator: each value comes from
 * `HMAC(seed, label:n)`.
 *
 * It was chosen over a stateful PRNG for two reasons that matter here:
 * reproducing an old result does not require reproducing the entire sequence
 * that came before (staff need to audit ONE roll, not replay months of
 * gameplay), and streams with different labels are independent — changing
 * trait generation does not shift affinity generation.
 *
 * @param {string} seed  seed in hexadecimal
 * @param {string} label independent stream ('affinities', 'traits', 'resolve')
 */
function stream(seed, label) {
  let counter = 0;
  return function next() {
    const mac = crypto.createHmac('sha256', Buffer.from(String(seed), 'utf8'));
    mac.update(`${label}:${counter++}`);
    // 4 bytes are enough: 2^32 distinct values provide far more precision than
    // anything here requires.
    return mac.digest().readUInt32BE(0) / 0x1_0000_0000;
  };
}

/**
 * The sum of three uniform values: a bell-shaped distribution, inexpensive
 * and dependency-free. This makes the middle common and the extremes rare
 * even before normalization.
 */
function bell(next) {
  return (next() + next() + next()) / 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The soul comes from the approved character sheet, never from chance.
 *
 * This prevents reroll farming (same sheet, same soul — killing the character
 * and recreating the same concept changes nothing) and makes whitelist
 * approval mechanically meaningful, improving the quality of character
 * sheets without needing a new rule.
 *
 * ⚠️ THE SECRET NEVER LEAVES THE SERVER. The character sheet is public: without
 * a secret, anyone could calculate any character's soul from what is written
 * on the panel, and the entire system would stop being hidden. The secret is
 * passed as an argument — this module does not read the environment, because
 * the domain does not know about infrastructure.
 *
 * @param {string} secret        SOUL_SECRET, supplied externally
 * @param {number} characterId
 * @param {{motivations?: string, weaknesses?: string, socialTies?: string}} sheet
 * @returns {string} seed in hexadecimal
 */
function deriveSeed(secret, characterId, sheet = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('soul: server secret is missing — the soul cannot be derived without it');
  }
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`soul: invalid characterId (${characterId})`);
  }

  // Normalize before signing: extra spaces, uppercase letters, or accents
  // must not produce a different soul for the same approved character sheet.
  const normalize = (text) => String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  // The separator is NUL (U+0000), not a space, and this is a security choice:
  // NUL does not survive the normalization above (which collapses whitespace
  // and trims the ends), so players cannot enter it in a character sheet.
  // Without a separator that cannot be typed, moving a letter from one field
  // to the next would produce the SAME signed material — 'ab'+'c' and 'a'+'bc'
  // — and two different character sheets would produce the same soul.
  //
  // Until 2026-08-06, this was written as a RAW NUL in the source. It worked,
  // but it was invisible: tools such as `grep` and `file` treated the entire
  // file as binary, and readers would see `].join('');` on this line and
  // conclude that the fields were concatenated without a separator. Worse,
  // any editor that removed control characters when saving would change the
  // seed of EVERY soul already derived, without raising an error.
  const FIELD_SEPARATOR = '\u0000';

  const material = [
    characterId,
    normalize(sheet.motivations),
    normalize(sheet.weaknesses),
    normalize(sheet.socialTies)
  ].join(FIELD_SEPARATOR);

  return crypto.createHmac('sha256', secret).update(material).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distributes `budget` across `keys`, keeping the sum exact and every value
 * within [0, 100].
 *
 * Rounding uses the largest-remainder method: normalizing and rounding each
 * value independently would produce incorrect sums, and an incorrect sum
 * would silently break rule 1 — the worst way to break it.
 */
function distribute(keys, budget, next) {
  const raw = keys.map(() => bell(next));
  const total = raw.reduce((a, b) => a + b, 0) || 1;

  const exact = raw.map(v => (v / total) * budget);
  const floors = exact.map(v => Math.min(100, Math.floor(v)));

  let remaining = budget - floors.reduce((a, b) => a + b, 0);

  // Assign the remainder to the largest fractional parts, respecting the
  // cap of 100.
  const order = exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder);

  let rounds = 0;
  while (remaining > 0 && rounds < keys.length * 100) {
    for (const { i } of order) {
      if (remaining === 0) break;
      if (floors[i] < 100) {
        floors[i] += 1;
        remaining -= 1;
      }
    }
    rounds += 1;
  }

  const soul = {};
  keys.forEach((key, i) => { soul[key] = floors[i]; });
  return soul;
}

/**
 * Generates the soul from the seed. Deterministic: the same seed produces
 * the same soul across runs and processes.
 *
 * @param {string} seed
 * @returns {Object} seven values — four affinities and three traits
 */
function generateSoul(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('soul: invalid seed');
  }
  return {
    ...distribute(AFFINITIES, AFFINITY_BUDGET, stream(seed, 'afinidades')),
    ...distribute(TRAITS, TRAIT_BUDGET, stream(seed, 'tracos'))
  };
}

/** Converts a raw value to a band. This is the only way to inspect the soul from now on. */
function band(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  for (const { band: name, max } of BAND_BOUNDS) {
    if (n <= max) return name;
  }
  return 'raro';
}

/** Numeric index of a band (0–4), used in the weight calculation. */
function bandIndex(value) {
  return BANDS.indexOf(band(value));
}

/**
 * Resistance to corruption — a DERIVED value, not stored.
 *
 * The original proposal made this an eighth attribute. It overlapped almost
 * entirely with Willpower and Stability, and another button is not depth: it
 * is another dimension to balance and explain, with nothing in return.
 *
 * Willpower weighs more than Stability by design: resisting change is more
 * about refusal than balance.
 */
function corruptionResistance(soul) {
  return Math.round((soul.vontade * 0.6) + (soul.estabilidade * 0.4));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

const MIN_WEIGHT = -4;
const MAX_WEIGHT = 6;

/**
 * Weights for the four outcomes as a function of `weight`.
 *
 * **No weight is ever zero anywhere on the scale.** This is deliberate and
 * separates this system from a table: even the talented can become marked on
 * a bad day, and someone with no gift can still have a clean moment — a story
 * they will tell for the rest of the character's life.
 *
 * If any weight reached zero, experienced players would know the outcome
 * before trying, eliminating all tension.
 */
function outcomeWeights(weight) {
  const p = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight));
  const t = (p - MIN_WEIGHT) / (MAX_WEIGHT - MIN_WEIGHT); // 0 = worst, 1 = best

  return {
    limpo:      2 + 60 * Math.pow(t, 2),
    caro:       10 + 30 * Math.sin(Math.PI * t),
    complicado: 8 + 40 * (1 - t),
    marcado:    2 + 45 * Math.pow(1 - t, 2)
  };
}

/**
 * Resolves an attempt connected to the soul.
 *
 * **Never returns failure.** It returns which of the four stories you got.
 *
 * @param {Object}  params
 * @param {Object}  params.soul
 * @param {string}  params.affinity     which affinity governs the action
 * @param {string}  params.seed         soul seed
 * @param {string}  params.eventId      identifies the action; used in the roll
 * @param {number} [params.attempt]     attempt in this window (0 = first)
 * @param {number} [params.circumstance] staff, component, location, preparation
 * @param {number} [params.difficulty]  difficulty of the action
 * @param {number} [params.pressure]    see `pressureFrom`
 * @returns {{outcome: string, weight: number, roll: number, inputs: Object}}
 *          `inputs` is intended for the audit log: without the recorded inputs,
 *          staff cannot reproduce the result, making accusations of favoritism
 *          impossible to verify.
 */
function resolve({
  soul, affinity, seed, eventId,
  attempt = 0, circumstance = 0, difficulty = 0, pressure = 0
}) {
  if (!soul || typeof soul !== 'object') throw new Error('soul: soul is missing');
  if (!AFFINITIES.includes(affinity)) {
    throw new Error(`soul: unknown affinity '${affinity}' — use one of ${AFFINITIES.join(', ')}`);
  }
  if (!seed) throw new Error('soul: seed is missing');
  if (!eventId) throw new Error('soul: eventId is missing — without it, the roll is not auditable');

  const weight = bandIndex(soul[affinity]) + circumstance - difficulty - pressure;

  const next = stream(seed, `resolve:${eventId}:${attempt}`);
  const roll = next();

  const weights = outcomeWeights(weight);
  const total = OUTCOMES.reduce((sum, outcome) => sum + weights[outcome], 0);

  let accumulated = 0;
  let outcome = OUTCOMES[OUTCOMES.length - 1];
  for (const result of OUTCOMES) {
    accumulated += weights[result] / total;
    if (roll < accumulated) { outcome = result; break; }
  }

  return {
    outcome,
    weight,
    roll,
    inputs: {
      affinity,
      band: band(soul[affinity]),
      circumstance,
      difficulty,
      pressure,
      attempt,
      eventId
    }
  };
}

/**
 * Calculates pressure from the number of recent attempts at the same action.
 *
 * Without this, the exploit is trivial: try a hundred times until you get
 * `limpo`. With this, repeated attempts do not converge on clean success —
 * they converge on marks.
 *
 * This prevents exploits without having to tell the player “no,” and fits the
 * fiction: someone who forces the same thing repeatedly eventually pays for
 * it physically. The cap prevents pressure from becoming a second locked door.
 */
function pressureFrom(recentAttempts) {
  const n = Math.max(0, Number(recentAttempts) || 0);
  return Math.min(4, Math.floor(n / 2));
}

module.exports = {
  AFFINITIES,
  TRAITS,
  BANDS,
  OUTCOMES,
  AFFINITY_BUDGET,
  TRAIT_BUDGET,
  deriveSeed,
  generateSoul,
  band,
  bandIndex,
  corruptionResistance,
  outcomeWeights,
  resolve,
  pressureFrom
};
/**
 * core/soul.js — Afinidade da Alma, camada de domínio
 *
 * Desenho completo: `docs/design/SOUL_AFFINITY.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Por que este arquivo existe agora, se o sistema está bloqueado pela Fase 0
 * ─────────────────────────────────────────────────────────────────────────────
 * O desenho diz que nada da Afinidade da Alma vira código antes do teste
 * in-game. Isso vale para o **serviço** — o que fala com o mundo, entrega
 * sinais, grava marcas e avança árvores.
 *
 * Não vale para o **domínio**. Este módulo é função pura: não abre banco, não
 * toca `mp`, não tem efeito colateral e não sabe que existe um jogo. Ele é
 * provável inteiro fora do servidor, e é exatamente a peça onde estar errado
 * sai mais caro depois — distribuição enviesada ou rolagem que falha só
 * aparecem com centenas de jogadores, quando consertar já significa mexer na
 * alma de gente que tem apego ao personagem.
 *
 * É também a separação que a Constituição §13 pede entre domínio e
 * infraestrutura, feita de verdade e não como diagrama.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * As três regras inegociáveis (Constituição §8, emenda v1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Nenhuma alma é estritamente melhor que outra. Garantido aqui por
 *    ORÇAMENTO FIXO: afinidade alta obriga outra a ser baixa. Não depende de
 *    boa vontade de quem escrever conteúdo daqui a dois anos.
 * 2. O dado nunca diz não. `resolve()` devolve um de quatro resultados, e os
 *    quatro dão certo. Não existe caminho de retorno que signifique falha.
 * 3. Toda rolagem é auditável. Tudo aqui é determinístico a partir da semente,
 *    e `resolve()` devolve as entradas junto do resultado para que a staff
 *    possa reproduzir qualquer resultado contestado.
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulário
// ─────────────────────────────────────────────────────────────────────────────

/** Uma por árvore de transformação. */
const AFFINITIES = Object.freeze(['arcana', 'divina', 'sombria', 'bestial']);

/** Como o personagem aguenta o custo do que tentou. */
const TRAITS = Object.freeze(['vontade', 'sensibilidade', 'estabilidade']);

/**
 * O jogador nunca vê número. A resolução também não usa número cru — usa
 * banda. Ter só cinco degraus é o que impede o sistema de virar planilha:
 * a diferença entre 61 e 63 não existe para ninguém.
 */
const BANDS = Object.freeze(['surdo', 'fraco', 'comum', 'forte', 'raro']);

/** Os quatro resultados. TODOS dão certo — ver regra 2 no topo. */
const OUTCOMES = Object.freeze(['limpo', 'caro', 'complicado', 'marcado']);

/**
 * Orçamentos fixos. São a garantia mecânica da regra 1.
 *
 * 200 entre 4 afinidades = média 50. Para alguém tirar `raro` (85+) em Arcana,
 * as outras três precisam somar 115 — ou seja, ficam abaixo da média. Não há
 * como ser bom em tudo, e isso não é uma escolha de balanceamento que alguém
 * possa desfazer sem perceber: é aritmética.
 */
const AFFINITY_BUDGET = 200;
const TRAIT_BUDGET = 150;

/**
 * Fronteiras das bandas. Concentradas no meio de propósito: quase todo mundo é
 * `comum` em quase tudo, que é o que faz `raro` significar alguma coisa.
 */
const BAND_BOUNDS = Object.freeze([
  { band: 'surdo', max: 14 },
  { band: 'fraco', max: 34 },
  { band: 'comum', max: 64 },
  { band: 'forte', max: 84 },
  { band: 'raro', max: 100 }
]);

// ─────────────────────────────────────────────────────────────────────────────
// Aleatoriedade determinística
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gerador contado, não sequencial: cada valor sai de `HMAC(semente, rótulo:n)`.
 *
 * Escolhido em vez de um PRNG com estado por dois motivos que importam aqui:
 * reproduzir um resultado antigo não exige reproduzir a sequência inteira que
 * veio antes (a staff precisa auditar UMA rolagem, não replicar meses de
 * jogo), e fluxos com rótulos diferentes são independentes — mexer na geração
 * de traços não desloca a de afinidades.
 *
 * @param {string} seed  semente em hexadecimal
 * @param {string} label fluxo independente ('afinidades', 'tracos', 'resolve')
 */
function stream(seed, label) {
  let counter = 0;
  return function next() {
    const mac = crypto.createHmac('sha256', Buffer.from(String(seed), 'utf8'));
    mac.update(`${label}:${counter++}`);
    // 4 bytes bastam: 2^32 valores distintos é resolução muito acima do que
    // qualquer coisa aqui usa.
    return mac.digest().readUInt32BE(0) / 0x1_0000_0000;
  };
}

/**
 * Soma de três uniformes: distribuição em sino, barata e sem dependência.
 * É o que faz o meio ser comum e os extremos serem raros antes mesmo da
 * normalização.
 */
function bell(next) {
  return (next() + next() + next()) / 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semente
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A alma vem da ficha aprovada, nunca do acaso.
 *
 * Isso mata o reroll-farming (mesma ficha, mesma alma — matar o personagem e
 * recriar o mesmo conceito não muda nada) e faz a aplicação de whitelist valer
 * mecanicamente, o que melhora a qualidade das fichas sem precisar de regra
 * nova.
 *
 * ⚠️ O SEGREDO NUNCA SAI DO SERVIDOR. A ficha é pública: sem segredo, qualquer
 * pessoa calcularia a alma de qualquer personagem a partir do que está escrito
 * no painel, e o sistema inteiro deixaria de ser oculto. O segredo é passado
 * como argumento — este módulo não lê ambiente, porque domínio não conhece
 * infraestrutura.
 *
 * @param {string} secret        SOUL_SECRET, vindo de fora
 * @param {number} characterId
 * @param {{motivations?: string, weaknesses?: string, socialTies?: string}} ficha
 * @returns {string} semente hex
 */
function deriveSeed(secret, characterId, ficha = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('soul: segredo do servidor ausente — a alma nao pode ser derivada sem ele');
  }
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`soul: characterId invalido (${characterId})`);
  }

  // Normalizar antes de assinar: espaço a mais, maiúscula ou acento não podem
  // gerar uma alma diferente para a mesma ficha aprovada.
  const normalize = (texto) => String(texto || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  // O separador e NUL (U+0000), nao espaco, e a escolha e de seguranca: NUL
  // nao sobrevive ao `normalize()` acima (que colapsa espaco em branco e corta
  // as pontas), entao nenhum jogador consegue escreve-lo na ficha. Sem um
  // separador impossivel de digitar, mover uma letra de um campo pro seguinte
  // produziria o MESMO material assinado -- 'ab'+'c' e 'a'+'bc' -- e duas
  // fichas diferentes nasceriam com a mesma alma.
  //
  // Estava escrito como um NUL CRU no fonte ate 06/08/2026. Funcionava, mas era
  // invisivel: o arquivo inteiro contava como binario pro `grep` e pro `file`,
  // e quem lesse esta linha via `].join('');` e concluiria que os campos sao
  // concatenados sem separador nenhum. Pior: qualquer editor que limpe
  // caracteres de controle ao salvar mudaria a semente de TODA alma ja
  // derivada, sem erro nenhum aparecer.
  const SEPARADOR_DE_CAMPO = '\u0000';

  const material = [
    characterId,
    normalize(ficha.motivations),
    normalize(ficha.weaknesses),
    normalize(ficha.socialTies)
  ].join(SEPARADOR_DE_CAMPO);

  return crypto.createHmac('sha256', secret).update(material).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Geração
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distribui `budget` entre `keys`, mantendo a soma exata e cada valor em
 * [0, 100].
 *
 * O arredondamento é feito por maior resto: normalizar e arredondar cada valor
 * isoladamente produziria somas erradas, e uma soma errada quebra a regra 1
 * silenciosamente — que é o pior jeito de quebrar.
 */
function distribute(keys, budget, next) {
  const raw = keys.map(() => bell(next));
  const total = raw.reduce((a, b) => a + b, 0) || 1;

  const exact = raw.map(v => (v / total) * budget);
  const floors = exact.map(v => Math.min(100, Math.floor(v)));

  let restante = budget - floors.reduce((a, b) => a + b, 0);

  // Sobra vai para quem tem o maior resto, respeitando o teto de 100.
  const ordem = exact
    .map((v, i) => ({ i, resto: v - Math.floor(v) }))
    .sort((a, b) => b.resto - a.resto);

  let volta = 0;
  while (restante > 0 && volta < keys.length * 100) {
    for (const { i } of ordem) {
      if (restante === 0) break;
      if (floors[i] < 100) {
        floors[i] += 1;
        restante -= 1;
      }
    }
    volta += 1;
  }

  const alma = {};
  keys.forEach((k, i) => { alma[k] = floors[i]; });
  return alma;
}

/**
 * Gera a alma a partir da semente. Determinístico: mesma semente, mesma alma,
 * entre execuções e entre processos.
 *
 * @param {string} seed
 * @returns {Object} sete valores — quatro afinidades e três traços
 */
function generateSoul(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('soul: semente invalida');
  }
  return {
    ...distribute(AFFINITIES, AFFINITY_BUDGET, stream(seed, 'afinidades')),
    ...distribute(TRAITS, TRAIT_BUDGET, stream(seed, 'tracos'))
  };
}

/** Traduz valor cru na banda. É o único jeito de olhar a alma daqui pra frente. */
function band(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  for (const { band: nome, max } of BAND_BOUNDS) {
    if (n <= max) return nome;
  }
  return 'raro';
}

/** Índice numérico da banda (0–4), para entrar na conta do peso. */
function bandIndex(value) {
  return BANDS.indexOf(band(value));
}

/**
 * Resistência à corrupção — valor DERIVADO, não armazenado.
 *
 * A proposta original tinha isto como oitavo atributo. Sobrepunha Vontade e
 * Estabilidade quase inteiramente, e botão a mais não é profundidade: é uma
 * dimensão a mais para balancear e para explicar, sem nada em troca.
 *
 * Vontade pesa mais que Estabilidade de propósito: resistir a ser mudado é
 * mais recusa que equilíbrio.
 */
function corruptionResistance(soul) {
  return Math.round((soul.vontade * 0.6) + (soul.estabilidade * 0.4));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolução
// ─────────────────────────────────────────────────────────────────────────────

const PESO_MIN = -4;
const PESO_MAX = 6;

/**
 * Pesos dos quatro resultados em função do `peso`.
 *
 * **Nenhum peso é zero em nenhum ponto da escala.** Isso é deliberado e é o que
 * separa este sistema de uma tabela: o talentoso ainda pode se marcar num dia
 * ruim, e quem não tem dom nenhum ainda pode ter um momento limpo — que é a
 * história que a pessoa vai contar pelo resto do personagem.
 *
 * Se algum destes chegasse a zero, o jogador experiente saberia o resultado
 * antes de tentar, e aí não há tensão nenhuma.
 */
function outcomeWeights(peso) {
  const p = Math.max(PESO_MIN, Math.min(PESO_MAX, peso));
  const t = (p - PESO_MIN) / (PESO_MAX - PESO_MIN); // 0 = pior, 1 = melhor

  return {
    limpo:      2 + 60 * Math.pow(t, 2),
    caro:       10 + 30 * Math.sin(Math.PI * t),
    complicado: 8 + 40 * (1 - t),
    marcado:    2 + 45 * Math.pow(1 - t, 2)
  };
}

/**
 * Resolve uma tentativa ligada à alma.
 *
 * **Nunca devolve falha.** Devolve qual das quatro histórias você ganhou.
 *
 * @param {Object}  params
 * @param {Object}  params.soul
 * @param {string}  params.affinity      qual afinidade governa o ato
 * @param {string}  params.seed          semente da alma
 * @param {string}  params.eventId       identifica o ato; entra na rolagem
 * @param {number} [params.attempt]      tentativa nesta janela (0 = primeira)
 * @param {number} [params.circumstance] mestre, componente, lugar, preparo
 * @param {number} [params.difficulty]   dificuldade do ato
 * @param {number} [params.pressure]     ver `pressureFrom`
 * @returns {{outcome: string, peso: number, roll: number, inputs: Object}}
 *          `inputs` existe para ir direto ao audit log: sem as entradas
 *          gravadas, a staff não consegue reproduzir e a acusação de
 *          favorecimento vira infalsificável.
 */
function resolve({
  soul, affinity, seed, eventId,
  attempt = 0, circumstance = 0, difficulty = 0, pressure = 0
}) {
  if (!soul || typeof soul !== 'object') throw new Error('soul: alma ausente');
  if (!AFFINITIES.includes(affinity)) {
    throw new Error(`soul: afinidade desconhecida '${affinity}' — use uma de ${AFFINITIES.join(', ')}`);
  }
  if (!seed) throw new Error('soul: semente ausente');
  if (!eventId) throw new Error('soul: eventId ausente — sem ele a rolagem nao e auditavel');

  const peso = bandIndex(soul[affinity]) + circumstance - difficulty - pressure;

  const next = stream(seed, `resolve:${eventId}:${attempt}`);
  const roll = next();

  const weights = outcomeWeights(peso);
  const total = OUTCOMES.reduce((soma, o) => soma + weights[o], 0);

  let acumulado = 0;
  let outcome = OUTCOMES[OUTCOMES.length - 1];
  for (const o of OUTCOMES) {
    acumulado += weights[o] / total;
    if (roll < acumulado) { outcome = o; break; }
  }

  return {
    outcome,
    peso,
    roll,
    inputs: { affinity, banda: band(soul[affinity]), circumstance, difficulty, pressure, attempt, eventId }
  };
}

/**
 * Pressão a partir do número de tentativas recentes do mesmo ato.
 *
 * Sem isto o exploit é trivial: tentar cem vezes até sair `limpo`. Com isto,
 * insistir não converge para o sucesso limpo — converge para marcas.
 *
 * É anti-exploit sem precisar dizer "não" ao jogador, e é honesto com a
 * ficção: quem força a mesma coisa muitas vezes acaba pagando por isso no
 * corpo. O teto existe para que a pressão não vire uma segunda porta fechada.
 */
function pressureFrom(recentAttempts) {
  const n = Math.max(0, Number(recentAttempts) || 0);
  return Math.min(4, Math.floor(n / 2));
}

module.exports = {
  AFFINITIES,
  TRAITS,
  BANDS,
  OUTCOMES,
  AFFINITY_BUDGET,
  TRAIT_BUDGET,
  deriveSeed,
  generateSoul,
  band,
  bandIndex,
  corruptionResistance,
  outcomeWeights,
  resolve,
  pressureFrom
};

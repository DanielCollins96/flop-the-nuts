const RANKS = [
  ["A", 14, "Ace", "Aces"],
  ["K", 13, "King", "Kings"],
  ["Q", 12, "Queen", "Queens"],
  ["J", 11, "Jack", "Jacks"],
  ["10", 10, "Ten", "Tens"],
  ["9", 9, "Nine", "Nines"],
  ["8", 8, "Eight", "Eights"],
  ["7", 7, "Seven", "Sevens"],
  ["6", 6, "Six", "Sixes"],
  ["5", 5, "Five", "Fives"],
  ["4", 4, "Four", "Fours"],
  ["3", 3, "Three", "Threes"],
  ["2", 2, "Two", "Twos"],
];

const SUITS = [
  { id: "h", name: "hearts", glyph: "&hearts;", red: true },
  { id: "d", name: "diamonds", glyph: "&diams;", red: true },
  { id: "c", name: "clubs", glyph: "&clubs;", red: false },
  { id: "s", name: "spades", glyph: "&spades;", red: false },
];

const CATEGORY_NAMES = [
  "High card",
  "One pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
];

const BOARD_SLOT_COUNT = 5;
const STREET_LABELS = ["Flop", "Flop", "Flop", "Turn", "River"];
const INITIAL_VISIBLE_TIER_COUNT = 24;
const TIER_PAGE_SIZE = 24;
const rankMeta = new Map(RANKS.map(([symbol, value, single, plural]) => [value, { symbol, single, plural }]));
const state = {
  history: [],
  index: -1,
  editingBoardIndex: null,
  heroCards: [],
  editingHeroIndex: null,
  visibleTierCount: INITIAL_VISIBLE_TIER_COUNT,
};

let els = null;
let currentBoard = null;
const boardAnalysisCache = new Map();
const tierWinRateCache = new Map();
const comboWinRateCache = new Map();
const heroWinRateCache = new Map();

function createDeck() {
  return RANKS.flatMap(([rank, value]) =>
    SUITS.map((suit) => ({
      rank,
      value,
      suit: suit.id,
      suitName: suit.name,
      glyph: suit.glyph,
      red: suit.red,
      code: `${rank}${suit.id}`,
    })),
  );
}

function drawRandomFlop() {
  const deck = createDeck();
  const flop = [];

  while (flop.length < 3) {
    const index = Math.floor(Math.random() * deck.length);
    flop.push(deck.splice(index, 1)[0]);
  }

  return sortCards(flop);
}

function sortCards(cards) {
  const suitOrder = new Map(SUITS.map((suit, index) => [suit.id, index]));
  return [...cards].sort((a, b) => b.value - a.value || suitOrder.get(a.suit) - suitOrder.get(b.suit));
}

function normalizeCommunityBoard(board) {
  return [...sortCards(board.slice(0, 3)), ...board.slice(3)];
}

function getRemainingCards(board) {
  const blocked = new Set(board.map((card) => card.code));
  return createDeck().filter((card) => !blocked.has(card.code));
}

function getHoleCombos(board) {
  const remaining = getRemainingCards(board);
  const combos = [];

  for (let i = 0; i < remaining.length - 1; i += 1) {
    for (let j = i + 1; j < remaining.length; j += 1) {
      combos.push(sortCards([remaining[i], remaining[j]]));
    }
  }

  return combos;
}

/** Fast numeric evaluator that returns a single integer score for comparison */
function evaluateFiveValue(c1, c2, c3, c4, c5) {
  const v1 = c1.value, v2 = c2.value, v3 = c3.value, v4 = c4.value, v5 = c5.value;
  // Flush check
  const isFlush = c1.suit === c2.suit && c1.suit === c3.suit && c1.suit === c4.suit && c1.suit === c5.suit;

  // Rank counts & sort
  const r = [v1, v2, v3, v4, v5].sort((a, b) => b - a);

  // Allocation-free frequency counting
  const groups = [];
  for (let i = 0; i < 5; i++) {
    const val = r[i];
    const existing = groups.find(g => g.val === val);
    if (existing) {
      existing.count++;
    } else {
      groups.push({ val, count: 1 });
    }
  }
  groups.sort((a, b) => b.count - a.count || b.val - a.val);

  // Straight check
  let straightHigh = 0;
  const isWheel = r[0] === 14 && r[1] === 5 && r[2] === 4 && r[3] === 3 && r[4] === 2;
  if (isWheel) {
    straightHigh = 5;
  } else {
    let isSequence = true;
    for (let i = 0; i < 4; i++) {
      if (r[i] - r[i + 1] !== 1) {
        isSequence = false;
        break;
      }
    }
    if (isSequence) straightHigh = r[0];
  }

  let cat = 0;
  let t = [0, 0, 0, 0, 0];

  if (isFlush && straightHigh) { cat = 8; t = [straightHigh]; }
  else if (groups[0].count === 4) { cat = 7; t = [groups[0].val, groups[1].val]; }
  else if (groups[0].count === 3 && groups[1].count === 2) { cat = 6; t = [groups[0].val, groups[1].val]; }
  else if (isFlush) { cat = 5; t = r; }
  else if (straightHigh) { cat = 4; t = [straightHigh]; }
  else if (groups[0].count === 3) { cat = 3; t = [groups[0].val, groups[1].val, groups[2].val]; }
  else if (groups[0].count === 2 && groups[1].count === 2) { cat = 2; t = [groups[0].val, groups[1].val, groups[2].val]; }
  else if (groups[0].count === 2) { cat = 1; t = [groups[0].val, groups[1].val, groups[2].val, groups[3].val]; }
  else { cat = 0; t = r; }

  // Encode to 32-bit int: [4 bits cat][4 bits t1][4 bits t2][4 bits t3][4 bits t4][4 bits t5]
  return (cat << 20) | (t[0] << 16) | (t[1] << 12) | (t[2] << 8) | (t[3] << 4) | (t[4] || 0);
}

function evaluateFive(cards) {
  const value = evaluateFiveValue(cards[0], cards[1], cards[2], cards[3], cards[4]);
  const category = (value >> 20) & 0xf;
  const t = [(value >> 16) & 0xf, (value >> 12) & 0xf, (value >> 8) & 0xf, (value >> 4) & 0xf, value & 0xf].filter(v => v > 0);
  return {
    category,
    tiebreakers: t,
    key: `${category}:${t.join(".")}`,
    value
  };
}

function evaluateBestValue(cards) {
  let best = -1;
  const len = cards.length;
  for (let a = 0; a < len - 4; a++) {
    for (let b = a + 1; b < len - 3; b++) {
      for (let c = b + 1; c < len - 2; c++) {
        for (let d = c + 1; d < len - 1; d++) {
          for (let e = d + 1; e < len; e++) {
            const val = evaluateFiveValue(cards[a], cards[b], cards[c], cards[d], cards[e]);
            if (val > best) best = val;
          }
        }
      }
    }
  }
  return best;
}

function evaluateBest(cards) {
  const value = evaluateBestValue(cards);
  const category = (value >> 20) & 0xf;
  const t = [(value >> 16) & 0xf, (value >> 12) & 0xf, (value >> 8) & 0xf, (value >> 4) & 0xf, value & 0xf].filter(v => v > 0);
  return {
    category,
    tiebreakers: t,
    key: `${category}:${t.join(".")}`,
    value
  };
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function sortNumbers(values) {
  return [...values].sort((a, b) => b - a);
}

function getStraightHigh(uniqueRanksDesc) {
  const ranks = [...uniqueRanksDesc].sort((a, b) => b - a);
  if (ranks.length !== 5) return null;
  if (ranks.join(",") === "14,5,4,3,2") return 5;

  for (let i = 0; i < ranks.length - 1; i += 1) {
    if (ranks[i] - ranks[i + 1] !== 1) return null;
  }

  return ranks[0];
}

function compareScores(a, b) {
  return a.value - b.value;
}

function compareCardsForDisplay(a, b) {
  return b[0].value - a[0].value || b[1].value - a[1].value || a[0].code.localeCompare(b[0].code);
}

function rankAllHands(board) {
  return getHoleCombos(board)
    .map((hole) => {
      const evaluation = evaluateBest([...board, ...hole]);
      return {
        hole,
        evaluation,
      };
    })
    .sort((a, b) => compareScores(b.evaluation, a.evaluation) || compareCardsForDisplay(a.hole, b.hole));
}

function buildTiers(results) {
  const tiers = [];

  for (const result of results) {
    const current = tiers[tiers.length - 1];
    if (!current || current.key !== result.evaluation.key) {
      tiers.push({
        key: result.evaluation.key,
        evaluation: result.evaluation,
        handName: describeScore(result.evaluation),
        combos: [result.hole],
      });
    } else {
      current.combos.push(result.hole);
    }
  }

  return tiers;
}

function describeScore(evaluation) {
  const [a, b, c] = evaluation.tiebreakers;

  switch (evaluation.category) {
    case 8:
      return `${rankSingle(a)}-high straight flush`;
    case 7:
      return `Four ${rankPlural(a)}, ${rankSingle(b)} kicker`;
    case 6:
      return `${rankPlural(a)} full of ${rankPlural(b)}`;
    case 5:
      return `${rankList(evaluation.tiebreakers)} flush`;
    case 4:
      return `${rankSingle(a)}-high straight`;
    case 3:
      return `Trip ${rankPlural(a)}, ${rankList(evaluation.tiebreakers.slice(1))} kickers`;
    case 2:
      return `${rankPlural(a)} and ${rankPlural(b)}, ${rankSingle(c)} kicker`;
    case 1:
      return `Pair of ${rankPlural(a)}, ${rankList(evaluation.tiebreakers.slice(1))} kickers`;
    default:
      return `${rankList(evaluation.tiebreakers)} high`;
  }
}

function rankSingle(value) {
  return rankMeta.get(value).single;
}

function rankPlural(value) {
  return rankMeta.get(value).plural;
}

function rankList(values) {
  return values.map((value) => rankMeta.get(value).symbol).join("-");
}

function cardHtml(card, size = "") {
  const classes = ["card", size, card.red ? "red" : ""].filter(Boolean).join(" ");
  return `
    <div class="${classes}" aria-label="${card.rank} of ${card.suitName}">
      <span class="rank">${card.rank}</span>
      <span class="suit" aria-hidden="true">${card.glyph}</span>
      <span class="rank rank-bottom" aria-hidden="true">${card.rank}</span>
    </div>
  `;
}

function boardCardHtml(card, index, selected = false) {
  return `
    <div class="card-slot">
      <button
        class="board-card-button${selected ? " selected" : ""}"
        type="button"
        data-board-index="${index}"
        aria-label="Change ${STREET_LABELS[index]} card: ${card.rank} of ${card.suitName}"
        aria-pressed="${selected}"
      >
        ${cardHtml(card)}
      </button>
      ${randomCardButtonHtml("board", index, `Randomize ${STREET_LABELS[index]} card`)}
    </div>
  `;
}

function boardPlaceholderHtml(index, selected = false, disabled = false) {
  return `
    <div class="card-slot">
      <button
        class="board-card-button board-card-placeholder${selected ? " selected" : ""}"
        type="button"
        data-board-index="${index}"
        ${disabled ? "disabled" : ""}
        aria-label="${disabled ? "Add turn before river" : `Choose ${STREET_LABELS[index]} card`}"
        aria-pressed="${selected}"
      >
        <span>${STREET_LABELS[index]}</span>
      </button>
      ${!disabled ? randomCardButtonHtml("board", index, `Randomize ${STREET_LABELS[index]} card`) : ""}
    </div>
  `;
}

function randomCardButtonHtml(type, index, label) {
  return `
    <button
      class="card-random-button"
      type="button"
      data-random-${type}-index="${index}"
      aria-label="${label}"
      title="${label}"
    >R</button>
  `;
}

function cardOptionHtml(card, blocked = false, selected = false) {
  return `
    <button
      class="card-option${selected ? " selected" : ""}"
      type="button"
      data-card-code="${card.code}"
      ${blocked ? "disabled" : ""}
      aria-label="${blocked ? "Unavailable: " : "Use "}${card.rank} of ${card.suitName}"
    >
      ${cardHtml(card, "small")}
    </button>
  `;
}

function heroCardHtml(card, index, selected = false) {
  const content = card 
    ? cardHtml(card)
    : `<span>Card ${index + 1}</span>`;
  
  const classes = ["board-card-button"];
  if (!card) classes.push("board-card-placeholder", "hero-card-placeholder");
  if (selected) classes.push("selected");
  
  return `
    <div class="card-slot">
      <button
        class="${classes.join(" ")}"
        type="button"
        data-hero-index="${index}"
        aria-label="${card ? `Change hole card ${index + 1}: ${card.rank} of ${card.suitName}` : `Choose hole card ${index + 1}`}"
        aria-pressed="${selected}"
      >
        ${content}
      </button>
      ${randomCardButtonHtml("hero", index, `Randomize hole card ${index + 1}`)}
    </div>
  `;
}

function comboHtml(combo, hidden = false, equityLift = null) {
  const tags = currentBoard ? comboRedrawTags(combo, currentBoard) : [];
  const liftText = equityLift !== null ? ` ${formatSignedPointValue(equityLift)}` : "";
  const tagText = tags.map((tag, index) => `${tag}${index === 0 ? liftText : ""}`);

  return `
    <div class="combo-pill${hidden ? " extra-combo" : ""}" aria-label="${combo.map((card) => `${card.rank} of ${card.suitName}`).join(", ")}${tagText.length ? `, ${tagText.join(", ")}` : ""}">
      <span class="combo-cards">${combo.map((card) => cardHtml(card, "small")).join("")}</span>
      ${tagText.length ? `<span class="redraw-tags">${tagText.map((tag) => `<span>${tag}</span>`).join("")}</span>` : ""}
    </div>
  `;
}

function boardCode(board) {
  return board.map((card) => card.code).join(" ");
}

function getBoardAnalysis(board) {
  const key = boardCode(board);
  const cached = boardAnalysisCache.get(key);
  if (cached) return cached;

  const results = rankAllHands(board);
  const tiers = buildTiers(results);
  const analysis = {
    key,
    results,
    tiers,
    totalCombos: results.length,
  };

  boardAnalysisCache.set(key, analysis);
  return analysis;
}

function boardTexture(board) {
  const suitCounts = countBy(board.map((card) => card.suit));
  const rankCounts = countBy(board.map((card) => card.value));
  const maxSuit = Math.max(...suitCounts.values());
  const paired = [...rankCounts.values()].some((count) => count > 1);
  const ranks = [...new Set(board.map((card) => card.value))].sort((a, b) => b - a);
  const connected = ranks.length === 3 && ranks[0] - ranks[2] <= 4;

  const parts = [];
  if (paired) parts.push("Paired");
  if (maxSuit === 3) parts.push("Monotone");
  else if (maxSuit === 2) parts.push("Two-tone");
  else parts.push("Rainbow");
  if (connected && !paired) parts.push("Connected");

  return parts.join(" / ");
}

function renderCurrentFlop() {
  if (!els) return;

  const board = state.history[state.index];
  currentBoard = board;
  const analysis = getBoardAnalysis(board);
  const { key: boardKey, tiers, totalCombos } = analysis;
  const nuts = tiers[0];
  const opponentCount = Number(els.opponentCount.value);
  const visibleTierCount = Math.min(tiers.length, state.visibleTierCount);
  const visibleTiers = tiers.slice(0, visibleTierCount);
  const winRates = normalizeTierWinRates(visibleTiers, estimateTierWinRates(visibleTiers, board, opponentCount));
  const nutsWinRate = winRates.get(nuts.key);
  const displayTiers = visibleTiers.map((tier) => ({
    ...tier,
    combos: sortCombosByRedraws(tier.combos, board),
  }));
  const comboLiftTargets = visibleComboKeys(displayTiers, board);
  const comboLift = estimateRedrawComboLift(displayTiers, board, opponentCount, winRates, comboLiftTargets);

  renderBoardEditor(board);
  renderHeroEditor(board, analysis);
  els.flopCode.textContent = boardKey;
  els.comboCount.textContent = totalCombos.toLocaleString();
  els.tierCount.textContent = tiers.length.toLocaleString();
  els.boardTexture.textContent = boardTexture(board);
  els.nutCombo.innerHTML = displayTiers[0].combos.slice(0, 3).map((combo) => comboHtml(combo, false, comboLift.get(comboKey(combo)))).join("");
  els.nutName.textContent = `${CATEGORY_NAMES[nuts.evaluation.category]}: ${nuts.handName}`;
  els.nutMeta.textContent = `${formatPercentValue(nutsWinRate)} win est. vs ${opponentCount} opponent${opponentCount === 1 ? "" : "s"} · ${formatPercentage(nuts.combos.length, totalCombos)} deal frequency`;
  els.rankingList.innerHTML = displayTiers.map((tier, index) => tierHtml(tier, index, totalCombos, winRates.get(tier.key), comboLift)).join("");
  renderRankingControls(visibleTierCount, tiers.length);
  updateRankingScrollTopButton();
  els.previousFlop.disabled = state.index <= 0;
}

function renderRankingControls(visibleTierCount, totalTierCount) {
  const hiddenTierCount = totalTierCount - visibleTierCount;
  els.rankingShown.textContent = `${visibleTierCount.toLocaleString()} of ${totalTierCount.toLocaleString()} tiers`;
  els.showMoreRankings.hidden = hiddenTierCount <= 0;
  els.showMoreRankings.textContent = `Show ${Math.min(TIER_PAGE_SIZE, hiddenTierCount)} more`;
}

function updateRankingScrollTopButton() {
  els.rankingScrollTop.hidden = els.rankingList.scrollTop < 180;
}

function renderHeroEditor(board, analysis) {
  els.heroCards.innerHTML = [0, 1].map((index) => heroCardHtml(state.heroCards[index], index, state.editingHeroIndex === index)).join("");

  if (state.editingHeroIndex === null) {
    els.heroPicker.hidden = true;
    els.heroPicker.innerHTML = "";
  } else {
    const selectedCard = state.heroCards[state.editingHeroIndex];
    const blocked = new Set([
      ...board.map((card) => card.code),
      ...state.heroCards.filter((card, index) => card && index !== state.editingHeroIndex).map((card) => card.code),
    ]);
    els.heroPicker.hidden = false;
    els.heroPicker.innerHTML = `
      <div class="card-picker-head">
        <strong>Choose hole card ${state.editingHeroIndex + 1}</strong>
        <div class="card-picker-actions">
          ${selectedCard ? `<button class="picker-remove" type="button" data-clear-hero-card>Clear</button>` : ""}
          <button class="picker-close" type="button" data-close-hero-picker aria-label="Close hand picker">&times;</button>
        </div>
      </div>
      <div class="card-picker-grid">
        ${createDeck().map((card) => cardOptionHtml(card, blocked.has(card.code), selectedCard?.code === card.code)).join("")}
      </div>
    `;
  }

  const summary = getHeroHandSummary(state.heroCards, board, analysis, Number(els.opponentCount.value));
  els.heroEquity.textContent = summary.title;
  els.heroMeta.textContent = summary.meta;
}

function renderBoardEditor(board) {
  els.flopCards.innerHTML = Array.from({ length: BOARD_SLOT_COUNT }, (_, index) => {
    if (board[index]) return boardCardHtml(board[index], index, state.editingBoardIndex === index);

    const disabled = index > board.length;
    return boardPlaceholderHtml(index, state.editingBoardIndex === index, disabled);
  }).join("");

  if (state.editingBoardIndex === null) {
    els.cardPicker.hidden = true;
    els.cardPicker.innerHTML = "";
    return;
  }

  const selectedCard = board[state.editingBoardIndex];
  const blocked = new Set([
    ...board.filter((_, index) => index !== state.editingBoardIndex).map((card) => card.code),
    ...state.heroCards.filter(Boolean).map((card) => card.code),
  ]);
  const canRemove = state.editingBoardIndex >= 3 && Boolean(selectedCard);
  els.cardPicker.hidden = false;
  els.cardPicker.innerHTML = `
    <div class="card-picker-head">
      <strong>Choose ${STREET_LABELS[state.editingBoardIndex]} card</strong>
      <div class="card-picker-actions">
        ${canRemove ? `<button class="picker-remove" type="button" data-remove-street>Remove ${STREET_LABELS[state.editingBoardIndex]}</button>` : ""}
        <button class="picker-close" type="button" data-close-picker aria-label="Close card picker">&times;</button>
      </div>
    </div>
    <div class="card-picker-grid">
      ${createDeck().map((card) => cardOptionHtml(card, blocked.has(card.code), selectedCard?.code === card.code)).join("")}
    </div>
  `;
}

function getHeroHandSummary(heroCards, board, analysis, opponentCount) {
  const selectedCards = heroCards.filter(Boolean);
  if (selectedCards.length !== 2) {
    return {
      title: "Pick two cards",
      meta: "Chance updates against the selected opponent count.",
    };
  }

  if (selectedCards.some((heroCard) => hasCard(board, heroCard))) {
    return {
      title: "Blocked card",
      meta: "Your hand cannot use a card already on the board.",
    };
  }

  const heroCombo = sortCards(selectedCards);
  const evaluation = evaluateBest([...board, ...heroCombo]);
  const key = comboKey(heroCombo);
  const tierIndex = analysis.tiers.findIndex((tier) => tier.key === evaluation.key);
  const tier = analysis.tiers[tierIndex];
  const equity = cachedHeroWinRate(heroCombo, board, opponentCount);
  const rank = tierIndex === 0 ? "Nuts" : `#${tierIndex + 1}`;
  const tierSize = tier ? `${tier.combos.length} combo${tier.combos.length === 1 ? "" : "s"}` : "custom combo";

  return {
    title: `${formatPercentValue(equity)} win est.`,
    meta: `${rank}: ${describeScore(evaluation)} · ${CATEGORY_NAMES[evaluation.category]} · ${tierSize}`,
  };
}

function visibleComboKeys(tiers, board) {
  const keys = new Set();

  for (const tier of tiers) {
    for (const combo of tier.combos) {
      if (comboRedrawTags(combo, board).length > 0) {
        keys.add(comboKey(combo));
      }
    }
  }

  return keys;
}

function normalizeTierWinRates(tiers, winRates) {
  const normalized = new Map();
  let bestAllowed = Infinity;

  for (const tier of tiers) {
    const rate = winRates.get(tier.key);
    const displayRate = Math.min(rate, bestAllowed);
    normalized.set(tier.key, displayRate);
    bestAllowed = displayRate;
  }

  return normalized;
}

function sortCombosByRedraws(combos, board) {
  return [...combos].sort((a, b) => {
    const redrawDelta = comboRedrawScore(b, board) - comboRedrawScore(a, board);
    if (redrawDelta !== 0) return redrawDelta;
    return compareCardsForDisplay(a, b);
  });
}

function comboRedrawScore(combo, board) {
  const cards = [...board, ...combo];
  const suitCounts = countBy(cards.map((card) => card.suit));
  const rankValues = [...new Set(cards.map((card) => card.value))];
  const bestSuitCount = Math.max(...suitCounts.values());
  const straightOuts = countStraightImprovementOuts(rankValues);
  const overcardScore = combo.reduce((sum, card) => sum + card.value, 0) / 100;

  // Three to a flush can make a backdoor flush by river; four to a flush is a direct draw.
  return bestSuitCount * 100 + straightOuts * 5 + overcardScore;
}

function comboRedrawTags(combo, board) {
  const cards = [...board, ...combo];
  const suitCounts = countBy(cards.map((card) => card.suit));
  const bestSuitCount = Math.max(...suitCounts.values());
  const straightOuts = countStraightImprovementOuts([...new Set(cards.map((card) => card.value))]);
  const tags = [];

  if (bestSuitCount >= 4) tags.push("FD");
  else if (bestSuitCount === 3) tags.push("BDFD");
  if (straightOuts >= 8) tags.push("SD");
  else if (straightOuts > 0) tags.push("BDSD");

  return tags;
}

function countStraightImprovementOuts(values) {
  const rankSet = new Set(values);
  let outs = 0;

  for (let low = 2; low <= 10; low += 1) {
    const straight = low === 10 ? [10, 11, 12, 13, 14] : [low, low + 1, low + 2, low + 3, low + 4];
    const present = straight.filter((rank) => rankSet.has(rank)).length;
    if (present === 4) outs += 8;
    else if (present === 3) outs += 2;
  }

  const wheel = [14, 2, 3, 4, 5];
  const wheelPresent = wheel.filter((rank) => rankSet.has(rank)).length;
  if (wheelPresent === 4) outs += 8;
  else if (wheelPresent === 3) outs += 2;

  return outs;
}

function tierHtml(tier, index, totalCombos, winRate, comboLift) {
  const expandedId = `tier-combos-${index}`;
  const hidden = Math.max(0, tier.combos.length - 4);
  const rank = index === 0 ? "Nuts" : `#${index + 1}`;
  const dealPercent = formatPercentage(tier.combos.length, totalCombos);

  return `
    <article class="tier-card">
      <div class="tier-head">
        <span class="tier-rank">${rank}</span>
        <div class="tier-title">
          <strong>${tier.handName}</strong>
          <span>${CATEGORY_NAMES[tier.evaluation.category]}</span>
        </div>
        <div class="tier-metrics">
          <div class="metric-block">
            <span>Win est.</span>
            <strong>${formatPercentValue(winRate)}</strong>
          </div>
          <div class="metric-block">
            <span>Deal</span>
            <strong>${dealPercent}</strong>
          </div>
          <span class="combo-count">${tier.combos.length} combo${tier.combos.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div id="${expandedId}" class="combo-list">
        ${tier.combos.map((combo, comboIndex) => comboHtml(combo, comboIndex >= 4, comboLift.get(comboKey(combo)))).join("")}
        ${hidden > 0 ? `<button class="more-combos" type="button" data-expand-target="${expandedId}" aria-expanded="false">+${hidden} more</button>` : ""}
      </div>
    </article>
  `;
}

function estimateTierWinRates(tiers, board, opponentCount) {
  const samples = equitySamplesFor(opponentCount);
  return new Map(
    tiers.map((tier) => [
      tier.key,
      cachedTierWinRate(tier, board, opponentCount, samples),
    ]),
  );
}

function cachedTierWinRate(tier, board, opponentCount, samples) {
  const key = `${boardCode(board)}:${tier.key}:${opponentCount}:${samples}`;
  if (!tierWinRateCache.has(key)) {
    tierWinRateCache.set(key, estimateTierWinRate(tier, board, opponentCount, samples, key));
  }

  return tierWinRateCache.get(key);
}

function equitySamplesFor(opponentCount) {
  return Math.max(180, 440 - opponentCount * 20);
}

function estimateRedrawComboLift(tiers, board, opponentCount, tierWinRates, targetComboKeys = null) {
  const samples = comboEquitySamplesFor(opponentCount);
  const lifts = new Map();

  for (const tier of tiers) {
    const rates = new Map();

    for (const combo of tier.combos) {
      const key = comboKey(combo);
      if (targetComboKeys && !targetComboKeys.has(key)) continue;
      if (comboRedrawTags(combo, board).length === 0) continue;
      rates.set(key, cachedComboWinRate(combo, board, opponentCount, samples));

      const matchingRankCombos = tier.combos.filter((candidate) => comboRankKey(candidate) === comboRankKey(combo));
      const cleanBaselines = matchingRankCombos.filter((candidate) => comboRedrawTags(candidate, board).length === 0);
      const baselineCombos = cleanBaselines.length > 0 ? cleanBaselines : matchingRankCombos.filter((candidate) => comboKey(candidate) !== comboKey(combo));
      const baselineRate = baselineCombos.length > 0
        ? average(baselineCombos.map((candidate) => {
          const candidateKey = comboKey(candidate);
          if (!rates.has(candidateKey)) {
            rates.set(candidateKey, cachedComboWinRate(candidate, board, opponentCount, samples));
          }
          return rates.get(candidateKey);
        }))
        : tierWinRates.get(tier.key);
      const lift = rates.get(key) - baselineRate;

      lifts.set(key, Math.max(0, lift));
    }
  }

  return lifts;
}

function cachedComboWinRate(combo, board, opponentCount, samples) {
  const key = `${boardCode(board)}:${comboKey(combo)}:${opponentCount}:${samples}:combo`;
  if (!comboWinRateCache.has(key)) {
    comboWinRateCache.set(key, estimateComboWinRate(combo, board, opponentCount, samples, key));
  }

  return comboWinRateCache.get(key);
}

function comboEquitySamplesFor(opponentCount) {
  return Math.max(8, 18 - opponentCount);
}

function heroEquitySamplesFor(opponentCount) {
  return Math.max(420, 900 - opponentCount * 45);
}

function cachedHeroWinRate(combo, board, opponentCount) {
  const samples = heroEquitySamplesFor(opponentCount);
  const key = `${boardCode(board)}:${comboKey(combo)}:${opponentCount}:${samples}:hero`;
  if (!heroWinRateCache.has(key)) {
    heroWinRateCache.set(key, estimateComboWinRate(combo, board, opponentCount, samples, key));
  }

  return heroWinRateCache.get(key);
}

function estimateComboWinRate(combo, board, opponentCount, samples, seedText) {
  const rng = seededRandom(hashText(seedText));
  let equity = 0;
  const boardCodes = new Set(board.map((c) => c.code));
  const comboCodes = new Set(combo.map((c) => c.code));
  const baseDeck = createDeck().filter((card) => !boardCodes.has(card.code) && !comboCodes.has(card.code));

  for (let sample = 0; sample < samples; sample += 1) {
    const deck = [...baseDeck];
    const runout = drawRunout(deck, rng, BOARD_SLOT_COUNT - board.length);
    const finalBoard = [...board, ...runout];
    const heroScore = evaluateBestValue([...finalBoard, ...combo]);
    let tiedOpponents = 0;
    let beaten = false;

    for (let opponent = 0; opponent < opponentCount; opponent += 1) {
      const opponentHand = [drawCard(deck, rng), drawCard(deck, rng)];
      const opponentScore = evaluateBestValue([...finalBoard, ...opponentHand]);
      const comparison = heroScore - opponentScore;

      if (comparison < 0) {
        beaten = true;
        break;
      }
      if (comparison === 0) tiedOpponents += 1;
    }

    if (!beaten) equity += tiedOpponents === 0 ? 1 : 1 / (tiedOpponents + 1);
  }

  return (equity / samples) * 100;
}

function estimateTierWinRate(tier, board, opponentCount, samples, seedText) {
  const rng = seededRandom(hashText(seedText));
  let equity = 0;
  const boardCodes = new Set(board.map((c) => c.code));
  const baseDeck = createDeck().filter((card) => !boardCodes.has(card.code));

  for (let sample = 0; sample < samples; sample += 1) {
    const hero = tier.combos[Math.floor(rng() * tier.combos.length)];
    const deck = baseDeck.filter((card) => card.code !== hero[0].code && card.code !== hero[1].code);
    const runout = drawRunout(deck, rng, BOARD_SLOT_COUNT - board.length);
    const finalBoard = [...board, ...runout];
    const heroScore = evaluateBestValue([...finalBoard, ...hero]);
    let tiedOpponents = 0;
    let beaten = false;

    for (let opponent = 0; opponent < opponentCount; opponent += 1) {
      const opponentHand = [drawCard(deck, rng), drawCard(deck, rng)];
      const opponentScore = evaluateBestValue([...finalBoard, ...opponentHand]);
      const comparison = heroScore - opponentScore;

      if (comparison < 0) {
        beaten = true;
        break;
      }
      if (comparison === 0) tiedOpponents += 1;
    }

    if (!beaten) equity += tiedOpponents === 0 ? 1 : 1 / (tiedOpponents + 1);
  }

  return (equity / samples) * 100;
}

function hasCard(cards, target) {
  return cards.some((card) => card.code === target.code);
}

function drawCard(deck, rng) {
  const index = Math.floor(rng() * deck.length);
  const card = deck[index];
  deck[index] = deck[deck.length - 1];
  deck.pop();
  return card;
}

function drawRunout(deck, rng, count) {
  const runout = [];
  for (let i = 0; i < count; i += 1) runout.push(drawCard(deck, rng));
  return runout;
}

function comboKey(combo) {
  return combo.map((card) => card.code).sort().join("|");
}

function comboRankKey(combo) {
  return combo.map((card) => card.value).sort((a, b) => b - a).join("|");
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function formatPercentage(count, total) {
  const percent = (count / total) * 100;
  return formatPercentValue(percent);
}

function formatPercentValue(percent) {
  if (percent < 0.1) return `${percent.toFixed(2)}%`;
  return `${percent.toFixed(1)}%`;
}

function formatSignedPointValue(points) {
  const sign = points >= 0 ? "+" : "";
  return `${sign}${points.toFixed(1)}`;
}

function pushFlop(flop) {
  state.editingBoardIndex = null;
  state.editingHeroIndex = null;
  state.history = state.history.slice(0, state.index + 1);
  state.history.push(flop);
  state.index = state.history.length - 1;
  clearHeroCardsBlockedByBoard(flop);
  renderCurrentFlop();
}

function setHeroCard(index, cardCode) {
  const board = state.history[state.index];
  const card = createDeck().find((deckCard) => deckCard.code === cardCode);
  if (!board || !card || index < 0 || index > 1) return false;
  if (hasCard(board, card)) return false;
  if (state.heroCards.some((heroCard, heroIndex) => heroIndex !== index && heroCard?.code === card.code)) return false;

  state.heroCards[index] = card;
  state.editingHeroIndex = null;
  renderCurrentFlop();
  return true;
}

function clearHeroCard(index) {
  if (index < 0 || index > 1 || !state.heroCards[index]) return false;
  state.heroCards[index] = null;
  state.editingHeroIndex = null;
  renderCurrentFlop();
  return true;
}

function clearHeroCardsBlockedByBoard(board) {
  state.heroCards = state.heroCards.map((card) => (card && hasCard(board, card) ? null : card));
}

function randomAvailableCardCode(blockedCodes) {
  const available = createDeck().filter((card) => !blockedCodes.has(card.code));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)].code;
}

function randomHeroCard(index) {
  const board = state.history[state.index];
  const selectedCard = state.heroCards[index];
  if (!board || index < 0 || index > 1) return false;

  const blocked = new Set([
    ...board.map((card) => card.code),
    ...state.heroCards.filter((card, heroIndex) => card && heroIndex !== index).map((card) => card.code),
  ]);
  if (selectedCard) blocked.add(selectedCard.code);

  const cardCode = randomAvailableCardCode(blocked);
  if (!cardCode) return false;
  return setHeroCard(index, cardCode);
}

function replaceCardInBoard(board, index, cardCode) {
  const replacement = createDeck().find((card) => card.code === cardCode);
  if (!board || !replacement || index < 0 || index >= BOARD_SLOT_COUNT || index > board.length) return false;
  if (board.some((card, boardIndex) => boardIndex !== index && card.code === replacement.code)) return false;

  const updatedBoard = [...board];
  updatedBoard[index] = replacement;
  return normalizeCommunityBoard(updatedBoard);
}

function replaceBoardCard(index, cardCode) {
  const updatedBoard = replaceCardInBoard(state.history[state.index], index, cardCode);
  if (!updatedBoard) return false;

  state.history[state.index] = updatedBoard;
  state.editingBoardIndex = null;
  clearHeroCardsBlockedByBoard(updatedBoard);
  renderCurrentFlop();
  return true;
}

function randomBoardCard(index) {
  const board = state.history[state.index];
  if (!board || index < 0 || index >= BOARD_SLOT_COUNT || index > board.length) return false;

  const blocked = new Set([
    ...board.filter((_, boardIndex) => boardIndex !== index).map((card) => card.code),
    ...state.heroCards.filter(Boolean).map((card) => card.code),
  ]);
  if (board[index]) blocked.add(board[index].code);

  const cardCode = randomAvailableCardCode(blocked);
  if (!cardCode) return false;
  return replaceBoardCard(index, cardCode);
}

function removeBoardStreet(board, index) {
  if (!board || index < 3 || index >= board.length) return false;
  return board.slice(0, index);
}

function removeCurrentBoardStreet(index) {
  const updatedBoard = removeBoardStreet(state.history[state.index], index);
  if (!updatedBoard) return false;

  state.history[state.index] = updatedBoard;
  state.editingBoardIndex = null;
  clearHeroCardsBlockedByBoard(updatedBoard);
  renderCurrentFlop();
  return true;
}

function bootBrowserApp() {
  els = {
    previousFlop: document.querySelector("#previous-flop"),
    nextFlop: document.querySelector("#next-flop"),
    showHandRankings: document.querySelector("#show-hand-rankings"),
    handRankingsDialog: document.querySelector("#hand-rankings-dialog"),
    closeHandRankings: document.querySelector("#close-hand-rankings"),
    flopCards: document.querySelector("#flop-cards"),
    nutCombo: document.querySelector("#nut-combo"),
    nutName: document.querySelector("#nut-name"),
    nutMeta: document.querySelector("#nut-meta"),
    comboCount: document.querySelector("#combo-count"),
    tierCount: document.querySelector("#tier-count"),
    boardTexture: document.querySelector("#board-texture"),
    rankingList: document.querySelector("#ranking-list"),
    rankingShown: document.querySelector("#ranking-shown"),
    showMoreRankings: document.querySelector("#show-more-rankings"),
    rankingScrollTop: document.querySelector("#ranking-scroll-top"),
    flopCode: document.querySelector("#flop-code"),
    opponentCount: document.querySelector("#opponent-count"),
    cardPicker: document.querySelector("#card-picker"),
    heroCards: document.querySelector("#hero-cards"),
    heroPicker: document.querySelector("#hero-picker"),
    heroEquity: document.querySelector("#hero-equity"),
    heroMeta: document.querySelector("#hero-meta"),
  };

  els.nextFlop.addEventListener("click", () => pushFlop(drawRandomFlop()));
  els.opponentCount.addEventListener("change", renderCurrentFlop);
  els.flopCards.addEventListener("click", (event) => {
    const randomButton = event.target.closest("[data-random-board-index]");
    if (randomButton) {
      randomBoardCard(Number(randomButton.dataset.randomBoardIndex));
      return;
    }

    const button = event.target.closest("[data-board-index]");
    if (!button || button.disabled) return;

    const index = Number(button.dataset.boardIndex);
    state.editingBoardIndex = state.editingBoardIndex === index ? null : index;
    state.editingHeroIndex = null;
    renderCurrentFlop();
  });
  els.cardPicker.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-close-picker]");
    if (closeButton) {
      state.editingBoardIndex = null;
      renderCurrentFlop();
      return;
    }

    const removeButton = event.target.closest("[data-remove-street]");
    if (removeButton && state.editingBoardIndex !== null) {
      removeCurrentBoardStreet(state.editingBoardIndex);
      return;
    }

    const option = event.target.closest("[data-card-code]");
    if (!option || option.disabled || state.editingBoardIndex === null) return;
    replaceBoardCard(state.editingBoardIndex, option.dataset.cardCode);
  });
  els.heroCards.addEventListener("click", (event) => {
    const randomButton = event.target.closest("[data-random-hero-index]");
    if (randomButton) {
      randomHeroCard(Number(randomButton.dataset.randomHeroIndex));
      return;
    }

    const button = event.target.closest("[data-hero-index]");
    if (!button) return;

    const index = Number(button.dataset.heroIndex);
    state.editingHeroIndex = state.editingHeroIndex === index ? null : index;
    state.editingBoardIndex = null;
    renderCurrentFlop();
  });
  els.heroPicker.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-close-hero-picker]");
    if (closeButton) {
      state.editingHeroIndex = null;
      renderCurrentFlop();
      return;
    }

    const clearButton = event.target.closest("[data-clear-hero-card]");
    if (clearButton && state.editingHeroIndex !== null) {
      clearHeroCard(state.editingHeroIndex);
      return;
    }

    const option = event.target.closest("[data-card-code]");
    if (!option || option.disabled || state.editingHeroIndex === null) return;
    setHeroCard(state.editingHeroIndex, option.dataset.cardCode);
  });
  els.rankingList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-expand-target]");
    if (!button) return;

    const target = document.getElementById(button.dataset.expandTarget);
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
    const expanded = target.classList.toggle("expanded");
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "Show less" : button.dataset.originalLabel;
  });
  els.previousFlop.addEventListener("click", () => {
    if (state.index > 0) {
      state.index -= 1;
      clearHeroCardsBlockedByBoard(state.history[state.index]);
      renderCurrentFlop();
    }
  });
  els.showMoreRankings.addEventListener("click", () => {
    state.visibleTierCount += TIER_PAGE_SIZE;
    renderCurrentFlop();
  });
  els.rankingList.addEventListener("scroll", updateRankingScrollTopButton);
  els.rankingScrollTop.addEventListener("click", () => {
    els.rankingList.scrollTo({ top: 0, behavior: "smooth" });
  });
  els.showHandRankings.addEventListener("click", () => {
    if (typeof els.handRankingsDialog.showModal === "function") {
      els.handRankingsDialog.showModal();
    } else {
      els.handRankingsDialog.setAttribute("open", "");
    }
  });
  els.closeHandRankings.addEventListener("click", () => {
    if (typeof els.handRankingsDialog.close === "function") {
      els.handRankingsDialog.close();
    } else {
      els.handRankingsDialog.removeAttribute("open");
    }
  });
  els.handRankingsDialog.addEventListener("click", (event) => {
    if (event.target !== els.handRankingsDialog) return;
    if (typeof els.handRankingsDialog.close === "function") {
      els.handRankingsDialog.close();
    } else {
      els.handRankingsDialog.removeAttribute("open");
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === "Escape" && (state.editingBoardIndex !== null || state.editingHeroIndex !== null)) {
      state.editingBoardIndex = null;
      state.editingHeroIndex = null;
      renderCurrentFlop();
      return;
    }
    if (event.target.closest("button, select")) return;
    if (event.code === "Space" || event.key === "n" || event.key === "N") {
      event.preventDefault();
      pushFlop(drawRandomFlop());
    }
  });

  pushFlop(drawRandomFlop());
}

if (typeof document !== "undefined") {
  bootBrowserApp();
}

globalThis.FlopTheNuts = {
  buildTiers,
  createDeck,
  evaluateBest,
  evaluateFive,
  estimateComboWinRate,
  estimateRedrawComboLift,
  estimateTierWinRate,
  estimateTierWinRates,
  cachedHeroWinRate,
  comboRedrawTags,
  getHeroHandSummary,
  getHoleCombos,
  normalizeTierWinRates,
  rankAllHands,
  removeBoardStreet,
  replaceCardInBoard,
  replaceBoardCard,
  sortCombosByRedraws,
  formatPercentValue,
  formatPercentage,
};

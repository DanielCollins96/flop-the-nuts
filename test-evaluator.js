await import("./app.js");

const { evaluateBest, evaluateFive, rankAllHands, buildTiers, createDeck, estimateTierWinRates, normalizeTierWinRates, removeBoardStreet, replaceCardInBoard, sortCombosByRedraws } = globalThis.FlopTheNuts;

const card = (rank, suit) => {
  const values = { A: 14, K: 13, Q: 12, J: 11, 10: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
  return { rank, value: values[rank], suit, suitName: suit, glyph: "", red: suit === "h" || suit === "d", code: `${rank}${suit}` };
};

const assertScore = (name, cards, category, tiebreakers) => {
  const result = evaluateFive(cards);
  const expected = `${category}:${tiebreakers.join(".")}`;
  if (result.key !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${result.key}`);
  }
};

const assertBestScore = (name, cards, category, tiebreakers) => {
  const result = evaluateBest(cards);
  const expected = `${category}:${tiebreakers.join(".")}`;
  if (result.key !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${result.key}`);
  }
};

assertScore("royal flush", [card("A", "s"), card("K", "s"), card("Q", "s"), card("J", "s"), card("10", "s")], 8, [14]);
assertScore("wheel straight", [card("A", "c"), card("5", "d"), card("4", "s"), card("3", "h"), card("2", "c")], 4, [5]);
assertScore("quads", [card("9", "c"), card("9", "d"), card("9", "s"), card("9", "h"), card("K", "c")], 7, [9, 13]);
assertScore("full house", [card("Q", "c"), card("Q", "d"), card("Q", "s"), card("6", "h"), card("6", "c")], 6, [12, 6]);
assertScore("two pair", [card("A", "c"), card("A", "d"), card("8", "s"), card("8", "h"), card("3", "c")], 2, [14, 8, 3]);
assertBestScore("seven-card best flush", [card("A", "s"), card("K", "s"), card("Q", "s"), card("8", "s"), card("4", "s"), card("A", "h"), card("2", "d")], 5, [14, 13, 12, 8, 4]);
assertBestScore("seven-card best full house", [card("A", "s"), card("A", "h"), card("A", "d"), card("K", "s"), card("K", "h"), card("2", "c"), card("3", "d")], 6, [14, 13]);

const deck = createDeck();
const board = ["Qh", "Jc", "10d"].map((code) => deck.find((deckCard) => deckCard.code === code));
const editedBoard = replaceCardInBoard(board, 1, "9s");
if (!editedBoard || editedBoard.map((boardCard) => boardCard.code).join(" ") !== "Qh 10d 9s") {
  throw new Error("expected flop card replacement to update and sort the board");
}
if (replaceCardInBoard(board, 1, "Qh") !== false) {
  throw new Error("expected flop card replacement to reject duplicate board cards");
}
if (replaceCardInBoard(board, 4, "2s") !== false) {
  throw new Error("expected river replacement to reject skipping the turn");
}
const turnBoard = replaceCardInBoard(board, 3, "2s");
if (!turnBoard || turnBoard.map((boardCard) => boardCard.code).join(" ") !== "Qh Jc 10d 2s") {
  throw new Error("expected turn card replacement to append after the flop");
}
const riverBoard = replaceCardInBoard(turnBoard, 4, "3s");
if (!riverBoard || riverBoard.map((boardCard) => boardCard.code).join(" ") !== "Qh Jc 10d 2s 3s") {
  throw new Error("expected river card replacement to append after the turn");
}
const riverRemoved = removeBoardStreet(riverBoard, 4);
if (!riverRemoved || riverRemoved.map((boardCard) => boardCard.code).join(" ") !== "Qh Jc 10d 2s") {
  throw new Error("expected river removal to leave the turn board");
}
const turnRemoved = removeBoardStreet(riverBoard, 3);
if (!turnRemoved || turnRemoved.map((boardCard) => boardCard.code).join(" ") !== "Qh Jc 10d") {
  throw new Error("expected turn removal to remove turn and river");
}
if (removeBoardStreet(riverBoard, 2) !== false) {
  throw new Error("expected flop cards not to be removable");
}
const tiers = buildTiers(rankAllHands(board));
const totalCombos = tiers.reduce((sum, tier) => sum + tier.combos.length, 0);
if (tiers.length <= 11 || totalCombos !== 1176) {
  throw new Error(`expected full tier set to cover 1,176 combos, got ${tiers.length} tiers and ${totalCombos} combos`);
}
const turnCombos = rankAllHands(turnBoard).length;
const riverCombos = rankAllHands(riverBoard).length;
if (turnCombos !== 1128 || riverCombos !== 1081) {
  throw new Error(`expected turn/river combo counts to be 1,128 and 1,081, got ${turnCombos} and ${riverCombos}`);
}
const winRates = estimateTierWinRates(tiers.slice(0, 3), board, 2);
if (winRates.size !== 3 || [...winRates.values()].some((rate) => rate < 0 || rate > 100)) {
  throw new Error("expected win estimates to be valid percentages");
}
const normalizedWinRates = normalizeTierWinRates(tiers.slice(0, 3), new Map([
  [tiers[0].key, 88],
  [tiers[1].key, 91],
  [tiers[2].key, 85],
]));
if (normalizedWinRates.get(tiers[0].key) !== 88 || normalizedWinRates.get(tiers[1].key) !== 88 || normalizedWinRates.get(tiers[2].key) !== 85) {
  throw new Error("expected normalized win estimates not to increase down the tier list");
}

const redrawBoard = ["9h", "7h", "5s"].map((code) => deck.find((deckCard) => deckCard.code === code));
const redrawTier = buildTiers(rankAllHands(redrawBoard)).find((tier) => tier.handName === "Nines and Fives, Seven kicker");
const sortedRedraws = sortCombosByRedraws(redrawTier.combos, redrawBoard);
if (!sortedRedraws[0].some((comboCard) => comboCard.suit === "h")) {
  throw new Error("expected heart backdoor flush combos to sort first inside the same made-hand tier");
}

console.log("Evaluator tests passed");

# Flop the Nuts

Interactive Texas Hold'em flop trainer.

Open `index.html` in a browser to cycle random flops and see the current nut hole cards plus every ranked hand tier. The evaluator ranks every legal two-card hole combo against the three-card flop, so each deal checks 1,176 possible hands. Each tier shows its percentage share of those possible hole-card combos and an estimated showdown win percentage, including split-pot equity, against the selected number of random opponents.

Combos inside a tier are sorted by redraw quality, with visible tags for flush and straight potential: `FD`, `BDFD`, `SD`, and `BDSD`. Redraw tags show an estimated combo-level percentage-point lift versus matching same-rank combos without redraws when that comparison exists, such as `BDFD +1.2`; neutral or noisy zero-value redraws show the tag only. The row-level win estimate is averaged across the tier's combos.

Run the evaluator smoke tests with:

```sh
npm test
```

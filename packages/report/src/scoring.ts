// Score display thresholds/colors are defined once in
// @squirrelscan/core-contracts/scoring. Re-exported here so report renderers
// and @squirrelscan/ui's ScoreCircle keep importing from "../scoring".
export {
  getScoreGrade,
  getScoreColor,
  getScoreInkColor,
  getScoreBand,
  getGroupColor,
  SCORE_THRESHOLDS,
  SCORE_COLORS,
  SCORE_INK_COLORS,
  GROUP_COLORS,
  type ScoreBand,
  type GroupColor,
} from "@squirrelscan/core-contracts/scoring";
